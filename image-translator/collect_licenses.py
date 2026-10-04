"""Include installed-distribution notices and a version inventory in the bundle."""
from importlib import metadata
from pathlib import Path
import sys

def main():
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    python_license=Path(sys.base_prefix)/'LICENSE.txt'
    if python_license.is_file():
        (output/'Python-LICENSE.txt').write_bytes(python_license.read_bytes())
    inventory = []
    for package in sorted(metadata.distributions(), key=lambda p: p.metadata.get('Name', '').lower()):
        name = package.metadata.get('Name', 'unknown')
        inventory.append(f'{name}=={package.version}')
        for entry in package.files or ():
            lower = str(entry).lower()
            if any(part in lower for part in ('license', 'copying', 'notice')):
                source = Path(package.locate_file(entry))
                if source.is_file():
                    safe_parts = [part for part in Path(str(entry)).parts if part not in ('..', '.', '/') and ':' not in part]
                    target = output / name / Path(*safe_parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read_bytes())
    (output / 'versions.txt').write_text('\n'.join(inventory) + '\n', encoding='utf-8')

if __name__ == '__main__':
    main()
