"""Measured Traditional Chinese footer, preserving decoded original pixels."""
import io
import unicodedata
from pathlib import Path
from PIL import Image, ImageFont, ImageDraw, ImageOps
from opencc import OpenCC
from storage import validate_inputs

FONT_PATH=Path(__file__).resolve().parent/'assets'/'NotoSansCJKtc-Regular.otf'
_converter=OpenCC('s2t')

class RenderError(ValueError):
    pass

def traditional(value):
    return _converter.convert(value)

def text(value,maximum,label,empty=False):
    if not isinstance(value,str) or len(value)>maximum or (not empty and not value.strip()) or any(unicodedata.category(c).startswith('C') for c in value):
        raise ValueError(f'{label}內容無效或超過字數限制')
    return traditional(value.strip())

def validate_draft(headline,points):
    headline=text(headline,40,'標題')
    if not isinstance(points,list) or not 1<=len(points)<=5:raise ValueError('請填寫 1–5 條賣點')
    return headline,[text(point,60,'賣點') for point in points]

def decode_original(data):
    if not data or len(data)>10*1024*1024:raise ValueError('原圖不能超過 10MiB')
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {'JPEG','PNG','WEBP'} or getattr(image,'n_frames',1)!=1:raise ValueError('僅支援靜態 JPEG、PNG、WebP 圖片')
            if image.width*image.height>20_000_000:raise ValueError('原圖不能超過 2000 萬像素')
            image.load();result=ImageOps.exif_transpose(image).convert('RGBA')
            if result.width<160:raise ValueError('原圖寬度至少需要 160 像素，才能顯示賣點文字')
            return result
    except ValueError:raise
    except Exception:raise ValueError('圖片無法解碼，請上傳有效的靜態圖片') from None

def wrap(value,font,width):
    lines=[];line=''
    for char in value:
        if line and font.getlength(line+char)>width:lines.append(line);line=''
        line+=char
    if line:lines.append(line)
    return lines

def render(original,headline,points):
    width=original.width;margin=max(8,round(width*.04))
    size=max(12,min(42,round(width*.035)))
    font=ImageFont.truetype(str(FONT_PATH),size)
    heading_font=ImageFont.truetype(str(FONT_PATH),min(52,round(size*1.22)))
    lead=round(size*1.65);heading_lead=round(heading_font.size*1.65)
    header=wrap(headline,heading_font,width-2*margin)
    rows=[wrap(point,font,width-3*margin) for point in points]
    footer=2*margin+len(header)*heading_lead+margin+sum(len(lines)*lead+margin for lines in rows)
    height=original.height+footer
    if width*height>16_000_000 or max(width,height)>16000:raise RenderError('加入賣點後超過 OSS 圖片限制（1600 萬像素或單邊 16000），請改用較小原圖或較短文字')
    result=Image.new('RGBA',(width,height),'white');result.paste(original,(0,0))
    draw=ImageDraw.Draw(result);y=original.height+margin
    for line in header:draw.text((margin,y),line,font=heading_font,fill='black');y+=heading_lead
    y+=margin
    radius=max(2,size//7)
    for lines in rows:
        draw.ellipse((margin,y+size//2,margin+2*radius,y+size//2+2*radius),fill=(36,150,73,255))
        for line in lines:draw.text((2*margin,y),line,font=font,fill='black');y+=lead
        y+=margin
    output=io.BytesIO();result.save(output,'PNG');data=output.getvalue()
    try:validate_inputs([('result.png',data)])
    except ValueError:raise RenderError('結果超過 OSS 圖片限制，請改用較小原圖或較短文字') from None
    return data
