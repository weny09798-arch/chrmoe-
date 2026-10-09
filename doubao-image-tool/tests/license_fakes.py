from license_authority import LicenseRequiredError, LicenseStatus


class PermittingAuthority:
    """Explicit isolated test dependency; never imported by production."""
    def __init__(self):
        self.allowed = True
        self.state = 'allowed'
        self.startups = 0
        self.reads = 0
        self.closed = False
        self.guards = []

    def status(self):
        self.reads += 1
        return LicenseStatus(self.allowed, self.state, message=self.state)

    def startup(self):
        self.startups += 1
        return self.status()

    def refresh(self):
        return self.status()

    def activate(self, code):
        self.allowed = code == 'renewed'
        self.state = 'allowed' if self.allowed else 'unknown_code'
        return self.status()

    def require_new_work(self, *, force_refresh=True):
        self.guards.append(force_refresh)
        status = self.status()
        if not status.allowed:
            raise LicenseRequiredError(status)
        return status

    def deny(self, state='expired'):
        self.allowed = False
        self.state = state

    def close(self):
        self.closed = True
