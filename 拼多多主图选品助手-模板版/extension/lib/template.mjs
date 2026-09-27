// Field order and instruction block transcribed from the user's 导入产品模板.xls.
// Its example merchandise rows are deliberately omitted from exports.
export const TEMPLATE_HEADERS = [
  '*产品主编号', '*产品名称', '货币类型', '产品主图', '货源链接', '货源平台', '货源ID',
  '详情描述', '详情图', '货源类目', '自定义属性', '产品视频', '产品证书', '尺寸图表',
  'SKU规格1', 'SKU规格2', '平台SKU', '*SKU售价', 'SKU图片', 'SKU库存', 'SKU重量(KG)', 'SKU尺寸(CM)'
];

export const TEMPLATE_INSTRUCTIONS = [
  '各个字段说明：',
  '1、产品主编号：一个SKU一行,若多个SKU同属于一个产品,请填入相同的产品主编号',
  '2、产品主图：输入图片链接，多个用中文逗号分割。注意：同一产品只需第一个SKU填写产品主图，其他SKU可忽略此列；',
  '3、详情图：输入图片链接，多个用中文逗号分割。注意：同一产品只需第一个SKU填写详情图，其他SKU可忽略此列',
  '4、自定义属性：输入产品属性，多个属于用分号""；""分隔，例如：品牌:VOC；货号:D001；镜片材料:TAC',
  '5、产品主编号、产品名称和SKU售价为必填项；',
  '6、规格表头支持适配名称：规格1、规格2、SKU规格1、SKU规格2、颜色、尺码、尺寸、色彩、型号、SKU颜色、SKU尺码、产品规格1(XXX)、产品规格2(XXX)、SKU规格(XXX)、SKU规格1（XXX）、SKU规格2（XXX）、规格(XXX)、规格1（XXX）、规格2（XXX） ',
  '7、产品标题表头支持适配名称：标题、产品标题、产品名称、名称',
  '8、以下案例为两个SPU的案例'
].join('\n');
