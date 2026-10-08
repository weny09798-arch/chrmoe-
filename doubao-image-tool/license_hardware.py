"""Windows identity: MachineGuid plus Windows system-volume serial; no fallback."""
import ctypes
from ctypes import wintypes
import hashlib
import os
import uuid


class HardwareIdentityError(ValueError):
    pass


def _machine_guid():
    if os.name != 'nt':
        raise HardwareIdentityError('无法读取 Windows 设备标识')
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Cryptography',
                        0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        return winreg.QueryValueEx(key, 'MachineGuid')[0]


def _system_volume_serial():
    if os.name != 'nt':
        raise HardwareIdentityError('无法读取 Windows 设备标识')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    directory = ctypes.create_unicode_buffer(32768)
    get_windows = kernel.GetWindowsDirectoryW
    get_windows.argtypes = [wintypes.LPWSTR, wintypes.UINT]
    get_windows.restype = wintypes.UINT
    size = get_windows(directory, len(directory))
    if not size or size >= len(directory):
        raise HardwareIdentityError('无法读取 Windows 设备标识')
    root = ctypes.create_unicode_buffer(32768)
    get_root = kernel.GetVolumePathNameW
    get_root.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    get_root.restype = wintypes.BOOL
    if not get_root(directory.value, root, len(root)):
        raise HardwareIdentityError('无法读取 Windows 设备标识')
    serial = wintypes.DWORD()
    volume = kernel.GetVolumeInformationW
    volume.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
                       ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                       ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD]
    volume.restype = wintypes.BOOL
    if not volume(root.value, None, 0, ctypes.byref(serial), None, None, None, 0):
        raise HardwareIdentityError('无法读取 Windows 设备标识')
    return serial.value


def windows_device_hash(machine_guid_reader=None, volume_id_reader=None):
    try:
        raw_guid = (machine_guid_reader or _machine_guid)()
        if not isinstance(raw_guid, str) or not raw_guid.strip():
            raise ValueError()
        guid = uuid.UUID(raw_guid.strip())
        serial = (volume_id_reader or _system_volume_serial)()
        if not guid.int or type(serial) is not int or not 0 < serial <= 0xFFFFFFFF:
            raise ValueError()
        raw = f'monthly-license:v1\n{guid}\n{serial:08x}'.encode('ascii')
        return hashlib.sha256(raw).hexdigest()
    except Exception:
        raise HardwareIdentityError('无法读取 Windows 设备标识，无法验证授权') from None
