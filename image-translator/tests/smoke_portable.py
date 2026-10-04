"""Real portable executable smoke test. Run with python smoke_portable.py path/to/exe."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw, ImageFont


def main():
    executable = Path(sys.argv[1]).resolve()
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with tempfile.TemporaryDirectory(prefix='portable-image-smoke-') as temp:
        output = Path(temp) / '指定输出目录'
        # Deliberately remove the development environment and model search hints.
        env = {key:value for key,value in os.environ.items() if key not in ('PYTHONPATH','PYTHONHOME','VIRTUAL_ENV')}
        process = subprocess.Popen([str(executable),'--no-browser','--output-dir',str(output)],cwd=temp,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',creationflags=flags)
        token, base = None, None
        try:
            line = process.stdout.readline().strip()
            assert line.startswith('Local URL: '),line
            base = line.removeprefix('Local URL: ').rstrip('/')
            index = urllib.request.urlopen(base+'/',timeout=15).read().decode('utf-8')
            token = re.search(r'name="local-token" content="([^"]+)"',index).group(1)
            assert urllib.request.urlopen(base+'/assets/app.js').status == 200
            image = Image.new('RGB',(600,150),'white')
            ImageDraw.Draw(image).text((30,40),'减少细菌滋生',font=ImageFont.truetype(r'C:\Windows\Fonts\msjh.ttc',56),fill='red')
            stream=io.BytesIO(); image.save(stream,'PNG'); source=stream.getvalue()
            boundary='portable-test-boundary'
            parts=[]
            for key,value in (('output_dir',str(output)),('mode','s2t')):
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode('utf-8'))
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="images"; filename="example.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+source+b'\r\n')
            body=b''.join(parts)+f'--{boundary}--\r\n'.encode()
            request=urllib.request.Request(base+'/api/jobs',data=body,headers={'X-Local-Token':token,'Content-Type':f'multipart/form-data; boundary={boundary}'},method='POST')
            job=json.load(urllib.request.urlopen(request,timeout=30))['id']
            for _ in range(300):
                request=urllib.request.Request(base+'/api/jobs/'+job,headers={'X-Local-Token':token})
                state=json.load(urllib.request.urlopen(request,timeout=15))
                if state['status'] in ('done','partial','error'):break
                time.sleep(.2)
            assert state['status']=='done',state
            result=state['results'][0]
            assert any(r['traditional']=='減少細菌滋生' and r['status']=='changed' for r in result['report']['regions']),result
            png=Path(result['paths']['png'])
            assert png.parent==output and png.exists()
            preview=urllib.request.urlopen(base+f'/api/jobs/{job}/image/0/result?token='+token).read()
            assert preview==png.read_bytes() and Image.open(io.BytesIO(preview)).size==(600,150)
            assert json.loads(Path(result['paths']['report']).read_text(encoding='utf-8'))==result['report']
            original=urllib.request.urlopen(base+f'/api/jobs/{job}/image/0/original?token='+token).read()
            assert hashlib.sha256(original).digest()==hashlib.sha256(source).digest()
            print('PASS: portable exe, local models/dictionaries, upload, OCR, preview, chosen output path, source preservation',flush=True)
        finally:
            if base and token:
                try:urllib.request.urlopen(urllib.request.Request(base+'/api/shutdown',data=b'',headers={'X-Local-Token':token},method='POST'),timeout=5).read()
                except Exception:pass
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
            if process.returncode:
                print(process.stdout.read(),flush=True)
                raise RuntimeError(f'Portable process exit {process.returncode}')


if __name__=='__main__':main()
