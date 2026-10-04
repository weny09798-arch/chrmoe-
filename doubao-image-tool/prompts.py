"""Editable image conversion instructions; optional redesign defaults off."""
def build_prompt(background=False, typography=False, extra=''):
    parts = ['请直接编辑本次上传的原图，并生成一张处理后的图片。不要搜索、推荐或引用其他商品图片。',
             '首要任務：將圖片中所有可辨識的簡體中文（包括包裝文字）轉為繁體中文。保留原文含義、所有數字、單位、品牌與產品身份，不增刪文案。',
             '重新設計背景，但保持產品清晰。' if background else '保留原有背景、產品外觀及顏色。',
             '優化排版與文字配色，確保文字清晰可讀。' if typography else '保留原有排版、字體風格及文字位置。',
             '完成後請逐字檢查是否仍有簡體字，直接生成並輸出處理後的圖片，不要只提供文字說明。']
    if extra.strip(): parts.append(extra.strip())
    return '\n'.join(parts)
