"""Authority state-machine tests with real signatures and controlled clocks/I/O."""
import copy
import json

import pytest

from test_license_components import envelope, signer


class Clock:
    def __init__(self):
        self.wall, self.mono = 1000.0, 5000.0
    def advance(self, seconds, *, wall=True):
        self.mono += seconds
        if wall:
            self.wall += seconds


class Store:
    def __init__(self):
        self.value = None
        self.fail = False
    def load(self):
        if self.fail:
            raise OSError('sensitive storage details')
        return copy.deepcopy(self.value)
    def save(self, value):
        if self.fail:
            raise OSError('sensitive storage details')
        self.value = copy.deepcopy(value)


class Service:
    def __init__(self, private, clock, store):
        self.private, self.clock, self.store = private, clock, store
        self.result = 'allowed'
        self.calls = []
        self.expiry = 1802592000
        self.changes = {}
        self.body_change = None
    def request(self, operation, code, device_hash, nonce):
        from license_transport import LicenseResponse, LicenseTransportOutage
        self.calls.append((operation, code, device_hash, nonce))
        # A denial/invalid response can never leave an old offline grant on disk.
        assert self.store.value['credential'] is None
        if self.result == 'outage':
            raise LicenseTransportOutage('test outage')
        if isinstance(self.result, Exception):
            raise self.result
        now = 1800000000 + int(self.clock.mono - 5000)
        if self.result != 'allowed':
            return LicenseResponse(403, {'status': self.result, 'server_time': now, 'expires_at': self.expiry})
        claims = dict(issued_at=now, expires_at=self.expiry,
                      lease_until=min(now + 86400, self.expiry), nonce=nonce)
        claims.update(self.changes)
        signed = envelope(self.private, **claims)
        body = {'status': 'allowed', 'server_time': now, 'expires_at': self.expiry, 'credential': signed}
        if self.body_change:
            self.body_change(body)
        return LicenseResponse(200, body)


@pytest.fixture
def rig(signer):
    from license_config import LicenseBuildConfig
    clock, store = Clock(), Store()
    service = Service(signer[0], clock, store)
    config = LicenseBuildConfig('https://license.example', signer[1])
    def create(**overrides):
        from license_authority import LicenseAuthority
        values = dict(config=config, store=store, transport=service,
                      hardware_provider=lambda: 'a' * 64,
                      wall_clock=lambda: clock.wall, monotonic_clock=lambda: clock.mono)
        values.update(overrides)
        return LicenseAuthority(**values)
    return create, clock, store, service


def activate(rig):
    authority = rig[0]()
    assert authority.activate('test-only-code-0123456789-abcdefghij').allowed
    return authority


def test_fixed_unconfigured_build_and_missing_hardware_deny(rig):
    from license_config import LicenseBuildConfig
    create, _, _, service = rig
    unconfigured = create(config=LicenseBuildConfig())
    assert unconfigured.startup().state == 'unconfigured'
    assert not unconfigured.activate('x' * 43).allowed
    missing = create(hardware_provider=lambda: None)
    assert missing.activate('x' * 43).state == 'hardware_unavailable'
    assert service.calls == []


def test_activation_anchors_signed_server_time_and_public_status_is_redacted(rig):
    authority = activate(rig)
    status = authority.status()
    assert status.allowed and not status.offline
    assert status.expires_at == 1802592000
    assert set(status.to_dict()) == {'allowed', 'status', 'expires_at', 'lease_until', 'offline',
                                     'message', 'remaining_days', 'checked_at'}
    assert status.remaining_days == 30
    assert status.checked_at == 1800000000
    assert status.message
    rendered = json.dumps(status.to_dict()) + repr(status)
    assert 'test-only-code' not in rendered and 'a' * 64 not in rendered and 'b' * 32 not in rendered
    assert rig[2].value['credential'] is not None


def test_saved_code_requires_online_startup_and_then_can_fallback_to_cached_lease(rig):
    activate(rig)
    create, clock, _, service = rig
    clock.advance(40)
    restarted = create()
    assert not restarted.status().allowed
    assert restarted.status().state == 'needs_validation'
    service.result = 'outage'
    status = restarted.startup()
    assert status.allowed and status.offline
    assert len(service.calls) == 2 and service.calls[-1][0] == 'validate'


def test_guards_refresh_on_demand_and_every_300_seconds_from_last_attempt(rig):
    authority = activate(rig)
    _, clock, _, service = rig
    authority.require_new_work(force_refresh=False)
    assert len(service.calls) == 1
    authority.require_new_work(force_refresh=True)
    assert len(service.calls) == 2
    clock.advance(299)
    authority.require_new_work(force_refresh=False)
    assert len(service.calls) == 2
    service.result = 'outage'
    clock.advance(1)
    assert authority.status().offline
    for _ in range(10):
        clock.advance(1)
        assert authority.status().offline
    assert len(service.calls) == 3
    assert len({call[3] for call in service.calls}) == 3


def test_offline_lease_ends_at_exact_24_hours_even_with_frozen_wall_clock(rig):
    from license_authority import LicenseRequiredError
    authority = activate(rig)
    _, clock, _, service = rig
    service.result = 'outage'
    clock.advance(86399, wall=False)
    assert authority.require_new_work(force_refresh=True).allowed
    clock.advance(1, wall=False)
    assert not authority.status().allowed
    with pytest.raises(LicenseRequiredError):
        authority.require_new_work(force_refresh=False)


def test_offline_permission_never_passes_exact_license_expiry(rig):
    rig[3].expiry = 1800000100
    authority = activate(rig)
    rig[3].result = 'outage'
    rig[1].advance(99)
    assert authority.refresh().allowed
    rig[1].advance(1)
    assert authority.status().state == 'expired'


@pytest.mark.parametrize('denial', ['disabled', 'unbound', 'unknown_code', 'device_mismatch', 'expired'])
def test_explicit_denial_irrevocably_clears_cache_but_preserves_code(rig, denial):
    authority = activate(rig)
    rig[3].result = denial
    assert authority.refresh().state == denial
    assert rig[2].value['credential'] is None
    assert rig[2].value['code'] == 'test-only-code-0123456789-abcdefghij'
    rig[3].result = 'outage'
    assert not authority.refresh().allowed
    assert not rig[0]().startup().allowed


@pytest.mark.parametrize('fault', ['signature', 'nonce', 'device', 'outer_expiry', 'outer_clock', 'shape', 'http500'])
def test_untrusted_live_response_cannot_use_previous_cache(rig, fault):
    from license_transport import LicenseResponseError
    authority = activate(rig)
    service = rig[3]
    if fault == 'signature':
        service.body_change = lambda body: body['credential'].update(signature='x' * 86)
    elif fault == 'nonce':
        service.changes = {'nonce': 'other_nonce_123456789'}
    elif fault == 'device':
        service.changes = {'device_hash': 'c' * 64}
    elif fault == 'outer_expiry':
        service.body_change = lambda body: body.update(expires_at=1809999999)
    elif fault == 'outer_clock':
        service.body_change = lambda body: body.update(server_time=1800000001)
    elif fault == 'shape':
        service.body_change = lambda body: body.update(credential={})
    else:
        service.result = LicenseResponseError('HTTP 500')
    assert not authority.refresh().allowed
    assert rig[2].value['credential'] is None
    service.result, service.changes, service.body_change = 'outage', {}, None
    assert not rig[0]().startup().allowed


def test_failed_activation_of_new_code_never_borrows_previous_codes_lease(rig):
    authority = activate(rig)
    rig[3].result = 'outage'
    assert not authority.activate('another-test-code-0123456789').allowed
    assert rig[2].value['code'] == 'another-test-code-0123456789'
    assert rig[2].value['credential'] is None
    assert not rig[0]().startup().allowed


@pytest.mark.parametrize('which', ['wall', 'mono'])
def test_clock_rollback_requires_successful_online_validation_even_if_clock_restored(rig, which):
    authority = activate(rig)
    clock, service = rig[1], rig[3]
    clock.advance(10)
    assert authority.status().allowed
    setattr(clock, which, getattr(clock, which) - 5)
    service.result = 'outage'
    assert not authority.status().allowed
    setattr(clock, which, getattr(clock, which) + 5)
    assert not authority.refresh().allowed
    service.result = 'allowed'
    assert authority.refresh().allowed


def test_restart_detects_persisted_wall_rollback_and_monotonic_reset(rig):
    activate(rig)
    rig[1].wall -= 1
    rig[3].result = 'outage'
    assert not rig[0]().startup().allowed
    rig[1].wall += 1
    assert not rig[0]().startup().allowed


def test_restart_elapsed_does_not_restart_offline_window(rig):
    activate(rig)
    rig[3].result = 'outage'
    rig[1].advance(86000)
    assert rig[0]().startup().allowed
    rig[1].advance(400)
    assert not rig[0]().startup().allowed


def test_persisted_monotonic_prevents_frozen_wall_restart_extension(rig):
    activate(rig)
    rig[3].result = 'outage'
    rig[1].advance(86400, wall=False)
    assert not rig[0]().startup().allowed


def test_storage_failure_prevents_request_and_cannot_resurrect_known_denial(rig):
    authority = activate(rig)
    rig[2].fail = True
    assert authority.refresh().state == 'storage_error'
    assert len(rig[3].calls) == 1
    rig[2].fail = False
    rig[3].result = 'disabled'
    # Even if the disk becomes unwritable after the server replies, preflight
    # persistence already removed the old permission.
    original = rig[3].request
    def deny_then_break_disk(*args):
        response = original(*args)
        rig[2].fail = True
        return response
    rig[3].request = deny_then_break_disk
    assert not authority.refresh().allowed
    rig[2].fail = False
    assert rig[2].value['credential'] is None
    rig[3].request, rig[3].result = original, 'outage'
    assert not rig[0]().startup().allowed


def test_cache_write_failure_after_online_success_fails_closed(rig):
    authority = activate(rig)
    original = rig[3].request
    def success_then_break_disk(*args):
        response = original(*args)
        rig[2].fail = True
        return response
    rig[3].request = success_then_break_disk
    assert authority.refresh().state == 'storage_error'
    assert not authority.status().allowed
    rig[2].fail = False
    assert rig[2].value['credential'] is None


def test_cache_device_mismatch_and_corruption_fail_closed(rig):
    activate(rig)
    other = rig[0](hardware_provider=lambda: 'c' * 64)
    rig[3].result = 'outage'
    assert not other.startup().allowed
    rig[2].value = {'code': 'valid-looking-code-0123456789'}
    assert rig[0]().startup().state == 'storage_error'


def test_nonfinite_clock_revokes_persisted_permission_across_restart(rig):
    authority = activate(rig)
    rig[1].wall = float('nan')
    assert not authority.status().allowed
    rig[1].wall = 1000.0
    rig[3].result = 'outage'
    assert not rig[0]().startup().allowed


def test_startup_with_unreadable_clock_cannot_leave_a_grant_for_later_restart(rig):
    activate(rig)
    rig[1].mono = float('nan')
    assert not rig[0]().startup().allowed
    rig[1].mono = 5000.0
    rig[3].result = 'outage'
    assert not rig[0]().startup().allowed


def test_monotonic_reset_on_reboot_forces_online_validation(rig):
    activate(rig)
    rig[1].mono = 10.0
    rig[3].result = 'outage'
    assert not rig[0]().startup().allowed


def test_close_denies_future_work_and_preserves_injected_transport_ownership(rig):
    from license_authority import LicenseRequiredError
    authority = activate(rig)
    authority.close()
    assert authority.status().state == 'closed'
    with pytest.raises(LicenseRequiredError):
        authority.require_new_work()
    assert len(rig[3].calls) == 1


def test_remaining_days_and_checked_at_use_signed_server_time_with_local_clock_skew(rig):
    authority = activate(rig)
    rig[1].advance(86400 - 1, wall=False)
    rig[3].result = 'outage'
    offline = authority.refresh()
    assert offline.remaining_days == 30 and offline.checked_at == 1800000000
    rig[3].result = 'allowed'
    rig[1].advance(1, wall=False)
    online = authority.refresh()
    assert online.remaining_days == 29 and online.checked_at == 1800086400
    assert rig[0]().status().checked_at == 1800086400
