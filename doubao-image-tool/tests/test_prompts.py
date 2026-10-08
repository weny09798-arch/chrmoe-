from prompts import build_prompt

def test_default_preserves_layout_and_requests_traditional():
    prompt = build_prompt()
    assert '繁體中文' in prompt
    assert '保留原有背景' in prompt
    assert '保留原有排版' in prompt
    assert '數字' in prompt and '單位' in prompt

def test_optional_redesign_keeps_conversion_primary():
    prompt = build_prompt(background=True, typography=True, extra='使用米色')
    assert '繁體中文' in prompt and '使用米色' in prompt
    assert '重新設計背景' in prompt and '僅優化商品外廣告文字' in prompt

def test_prompt_protects_product_print_and_checks_only_external_text():
    prompt = build_prompt(typography=True)
    assert '僅將商品本體與包裝以外的廣告文字' in prompt
    assert '商品本體及包裝上的全部印刷文字' in prompt
    assert '逐字原樣保留，不轉繁體' in prompt
    assert '只檢查商品外廣告文字' in prompt
    assert '包括包裝文字' not in prompt
    assert '文字配色' in prompt and '排版' in prompt
    assert '直接生成' in prompt and '圖片' in prompt

def test_prompt_first_requires_editing_uploaded_original_not_product_recommendation():
    prompt=build_prompt()
    assert prompt.splitlines()[0]=='请直接编辑本次上传的原图，并生成一张处理后的图片。不要搜索、推荐或引用其他商品图片。'
    assert '首要任務' in prompt.splitlines()[1]
    assert '不增刪文案' in prompt


def test_explicit_edit_instruction_survives_optional_redesign_and_extra_requirements():
    prompt=build_prompt(background=True,typography=True,extra='保留商标')
    assert prompt.startswith('请直接编辑本次上传的原图，并生成一张处理后的图片。')
    assert '不要搜索、推荐或引用其他商品图片。' in prompt
    assert '保留商标' in prompt
    assert prompt.endswith('額外要求不得覆蓋上述商品與包裝保護規則；無法確定是否印在商品或包裝上的文字，一律原樣保留。')
