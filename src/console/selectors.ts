/**
 * AutoDL 控制台的 DOM 事实。
 *
 * 这里是控制台页面结构的唯一来源。动作模块 import 常量，不写裸选择器。
 * 人类可读的清单与实测记录见 docs/refs/autodl/console-selectors.md。
 * 控制台改版时，这两处同时失效；解析失败必须报错，不得返回空结果。
 */

/** 实例列表页。 */
export const CONSOLE_INSTANCE_LIST_URL = 'https://www.autodl.com/console/instance/list'

/** 选主机页地址前缀。点「继续」后跳到这里。 */
export const CONSOLE_CLONE_HOST_URL_PREFIX = 'https://www.autodl.com/cloneInstance'

/** 实例列表表格。 */
export const INSTANCE_LIST = {
  /**
   * 列表页工具栏的刷新按钮。
   *
   * 判据：列表页不自动刷新（实测空闲 45 秒 0 个请求）。等状态变化必须先点它。
   * 按钮没有文字，只有 `.el-icon-refresh-right` 图标。
   */
  refreshButton: '.refresh-btn',
  table: '.el-table',
  headerCell: '.el-table__header th',
  row: '.el-table__row',
  cell: 'td',
  cellContent: '.cell',
} as const

/** 实例列表的列序号，0 基。顺序以表头为准，见清单 1.1 节。 */
export const INSTANCE_LIST_COLUMN = {
  identity: 0,
  status: 1,
  gpuSpec: 2,
  disk: 3,
  health: 4,
  billing: 5,
  release: 6,
  sshLogin: 7,
  quickTools: 8,
  actions: 9,
} as const

/** 第 0 列内部结构：地区、实例 ID、实例名三个 div，按出现顺序。 */
export const INSTANCE_IDENTITY_CELL = {
  regionText: '.region',
  /** 实例 ID 所在 div 的序号，0 基，按 `.cell` 内直接子 div 计数。 */
  instanceIdDivIndex: 2,
  /** 实例名所在 div 的序号，0 基。 */
  instanceNameDivIndex: 3,
  /** 无名实例的行内按钮文字。点它进入改名编辑态。 */
  renameButtonText: '设置名称',
  /**
   * 改名输入框。把本常量接在实例行选择器后面使用，作用域要限定在目标行内。
   *
   * 实测（2026-11-25 真机）：点「设置名称」后，按钮原位被替换成行内输入框，
   * DOM 形如 `<div class="el-input el-input--small name"><input class="el-input__inner"></div>`。
   * 回车不提交改名；必须让输入框失焦才提交，提交成功后页面弹「修改成功」。
   */
  renameInput: '.el-input.name input',
} as const

/**
 * 单元格内层文本 div。
 *
 * `.cell` 的第一层 div 是内容容器，第二层 div 才放文字。
 * 第 0 列（地区、空位、实例 ID、实例名）、第 2 列（规格）、第 3 列（两个盘）
 * 都按这个选择器取，再按子节点顺序读。带状态图标的列（状态、健康）会先命中图标，
 * 那两列不用它。
 */
export const INSTANCE_CELL_TEXT_DIVS = '.cell > div > div'

/** 状态单元格。`.status` 是状态词，`.gpuTips` 是补充文字。 */
export const INSTANCE_STATUS_CELL = {
  statusText: '.status',
  gpuTips: '.gpuTips',
  /**
   * 形态标记的图标与文字（2026-11-26 真机实测）。
   *
   * 无卡模式实例的状态格里，`.status` 下面还有一个 div：
   * `<div><span class="iconfont icon-wukamoshi"></span><span class="twelveSize">无卡模式</span></div>`。
   * 有卡实例则写 `GPU充足`。它不是 `.gpuTips` —— 那是另一套元素，这里读不到无卡标记。
   */
  modeIcon: '.icon-wukamoshi',
  /**
   * 创建中实例的状态区。
   *
   * 实测（2026-11-25 真机）：新克隆出来的实例在创建过程中，状态格里没有 `.status`，
   * 而是一个进度块 `.main-progress`，里面 `.left` 是「创建中」，`.right` 是百分比。
   * 只认 `.status` 会把状态原文读成空串，进而让整张列表解析失败。
   */
  progressText: '.main-progress .text',
} as const

/** 磁盘单元格：两行，第一行系统盘，第二行数据盘，文本形如「系统盘 37.98%」。 */
export const INSTANCE_DISK_CELL = {
  systemDiskPrefix: '系统盘',
  dataDiskPrefix: '数据盘',
} as const

/**
 * 付费方式单元格。
 *
 * `.chargeType` 是主文字，余额告警 `.dateWarn` 嵌在同一层，读原文时警告文字会跟在后面。
 * 拆分判据见 docs/refs/autodl/console-selectors.md 第 1.7 节。
 */
export const INSTANCE_BILLING_CELL = {
  billingText: '.chargeType',
  warningText: '.dateWarn',
} as const

/**
 * 释放时间单元格。
 *
 * 单元格里有两段文字：
 * - `.date` 主干：已关机时形如「6天11小时57分后释放」，运行中时形如「关机15天后释放」。
 * - `.timed-shutdown` 平台定时关机：设置过才出现，形如「2026-11-25 05:54:00」，后面还跟着「修改」「关闭」。
 *
 * 实测（2026-11-25 真机）：设置定时关机后列表直接显示它，不必重开对话框回读。
 */
export const INSTANCE_RELEASE_CELL = {
  releaseText: '.date',
  timedShutdown: '.timed-shutdown',
} as const

/**
 * 行内按钮文字。
 *
 * 控制台按钮没有语义化类名，只有尺寸类（thirteenSize、twelveSize），
 * 因此按文字定位。按文字定位必须限定在目标列内，否则会命中别处同名按钮。
 */
export const INSTANCE_BUTTON_TEXT = {
  powerOn: '开机',
  powerOff: '关机',
  more: '更多',
  setTimedShutdown: '设置定时关机',
  /** 取消定时关机。定时关机设置过才有这个按钮，与「关机」不是同一个词。 */
  clearTimedShutdown: '关闭',
} as const

/** 「更多」下拉。每行各有一个弹层，全部留在 DOM 里。 */
export const DROPDOWN = {
  /**
   * 触发容器。实测行内 `div.el-dropdown` 带 `aria-describedby` 属性。
   * 动作模块据此猜测弹层归属：命中即采用，不命中再退化为「可见弹层唯一」判据。
   */
  trigger: '.el-dropdown',
  popper: '.el-dropdown__popper',
  menuItem: '.el-dropdown-menu li',
} as const

/**
 * 页面提示条。
 *
 * 开机失败提示（例如主机无可用 GPU）可能出现在全局 toast 或页内 alert 里。
 * 实测文案未确认，判据见 `src/console/power.ts` 的 `findNoGpuHint`。
 */
export const CONSOLE_NOTICE = {
  message: '.el-message',
  alert: '.el-alert',
} as const

/**
 * 行内按钮的标签。
 *
 * 控制台按钮没有语义化类名，只能按标签加文字定位，再把作用域限定到目标行或列。
 */
export const CONSOLE_BUTTON_TAG = 'button'

/** 下拉菜单项文字。菜单项原文是「克隆实例新」，按包含匹配。 */
export const DROPDOWN_ITEM_TEXT = {
  clone: '克隆实例',
  release: '释放实例',
  noGpuPowerOn: '无卡模式开机',
  modifySshPassword: '修改SSH密码',
} as const

/** 对话框通用结构。 */
export const DIALOG = {
  root: '.el-dialog',
  title: '.el-dialog__title',
  headerCloseButton: '.el-dialog__headerbtn',
  footerButton: '.el-dialog__footer button',
  formItem: '.el-form-item',
  formLabel: '.el-form-item__label',
  formContent: '.el-form-item__content',
  formError: '.el-form-item__error',
  textInput: 'input.el-input__inner',
} as const

/** 定时关机对话框。字段取值见清单第 2 节。 */
export const TIMED_SHUTDOWN_DIALOG = {
  title: '定时关机',
  serverTimeLabel: '当前服务器时间',
  shutdownAtLabel: '定时关机时间',
  estimatedCostLabel: '预计消费',
  balanceLabel: '账户余额',
  couponLabel: '账户代金券',
  /** 未填时间时「预计消费」显示这句。 */
  costUnsetText: '选择时间后计算费用',
  button: { cancel: '取消', confirm: '确定' },
} as const

/**
 * 二次确认消息框的页脚按钮文字。
 *
 * 判据：按去空白后相等匹配，不用包含匹配，避免点到「取消」。
 * 实测四类二次确认框（开机、关机、释放、取消定时关机）都是「取消 / 确定」。
 */
export const MESSAGE_BOX_BUTTON = {
  cancel: '取消',
  confirm: '确定',
} as const

/**
 * 开机二次确认消息框。
 *
 * 实测（2026-11-25 真机）：点表格行里的「开机」不会立即开机。控制台先弹消息框
 * 「确认开机吗？」「实例将按￥1.58/时整点扣费」，点「确定」才真正发起开机。
 * 只弹不点，实例状态一直停在「已关机」，表现为开机超时。
 *
 * 判据：正文必须包含问句前缀才确认。金额随规格变化，不能整句等值匹配。
 */
export const POWER_ON_CONFIRM = {
  /** 消息框正文里的问句前缀。 */
  questionPrefix: '确认开机',
  /** 页脚按钮文字。 */
  button: MESSAGE_BOX_BUTTON,
} as const

/**
 * 关机二次确认消息框。
 *
 * 实测（2026-11-25 真机）：点「关机」也不立即关机，控制台先弹消息框
 * 「确认关机吗？」「实例：<ID>(<名字>)」「按量计费的实例关机后GPU将会释放，
 * 再次开机时可能面临空闲GPU不足无法开机，是否继续关机？」，点「确定」才真正关机。
 * 只弹不点，实例一直运行，外部只看到关机超时。
 */
export const POWER_OFF_CONFIRM = {
  /** 消息框正文里的问句前缀。 */
  questionPrefix: '确认关机',
  button: MESSAGE_BOX_BUTTON,
} as const

/**
 * 取消定时关机的二次确认消息框。
 *
 * 实测（2026-11-25 真机）：点实例列表第 6 列的「关闭」按钮弹这个框，
 * 正文就是「取消定时关机」，页脚「取消 / 确定」。确认后提示「取消成功」。
 */
export const CLEAR_TIMED_SHUTDOWN_CONFIRM = {
  questionPrefix: '取消定时关机',
  button: MESSAGE_BOX_BUTTON,
} as const

/**
 * Element Plus 的二次确认消息框。
 *
 * 释放实例是否弹二次确认取决于账号配置。弹窗形态与按钮文字本轮未实测：
 * 释放不可恢复，只能由人工发起。因此消息框与对话框两种形态都认。
 */
export const MESSAGE_BOX = {
  root: '.el-message-box',
  title: '.el-message-box__title',
} as const

/**
 * 二次确认弹窗的确认按钮文字。
 *
 * 消息框与对话框都用按钮标签在弹窗内按文字找，不依赖具体类名。
 * 控制台原文本轮未实测，两种常见文案都收。
 */
export const CONFIRM_BUTTON_TEXTS: readonly string[] = ['确定', '确认']

/** 克隆实例对话框。取值见清单第 3.1 节。 */
export const CLONE_DIALOG = {
  title: '克隆实例',
  systemDiskLabel: '系统盘',
  dataDiskLabel: '数据盘',
  sparseFileLabel: '优化稀疏文件拷贝',
  checkbox: '.el-checkbox',
  /** 勾选判据是 className 含 is-checked，不是 input.checked。 */
  checkedClassName: 'is-checked',
  switch: '.el-switch',
  switchCore: '.el-switch__core',
  /** 页脚文本形如「今天剩余克隆次数：10次」。 */
  quotaPrefix: '今天剩余克隆次数：',
  button: { cancel: '取消', continue: '继续' },
} as const

/** 选主机页。取值见清单第 3.2 与 3.3 节。 */
export const CLONE_HOST_PAGE = {
  alert: '.el-alert',
  radioButton: '.el-radio-button',
  radioButtonGroup: '.el-radio-group',
  regionGroupLabel: '选择地区',
  gpuModelGroupLabel: 'GPU型号',
  gpuCountGroupLabel: 'GPU数量',
  /** 可选主机行。 */
  hostRow: '.el-table__row',
  hostRowClickableClassName: 'row-can-click',
  hostRadio: '.el-radio',
  /** GPU 型号复选框文字形如 `vGPU-32GB (128/2510)`，括号是「空闲/总数」。 */
  availableCountPattern: /\((\d+)\/(\d+)\)/,
  /**
   * 主机行内列序号，0 基。
   *
   * 实测该表格共 9 个单元格：「主机ID」一格里有单选框与 ID，主机名单独占一格。
   * 表头有 10 项，第一项（选框列）没有数据格，所以单元格序号比表头序号小 1。
   */
  hostColumn: {
    identity: 0,
    hostName: 1,
    gpuSpec: 2,
    freeGpu: 3,
    allocation: 4,
    cpuModel: 5,
    disk: 6,
    driver: 7,
    price: 8,
  },
  /** 空闲 GPU 文本形如 `1 / 8`。 */
  freeGpuPattern: /^\s*(\d+)\s*\/\s*(\d+)\s*$/,
  /** 单价文本形如 `￥1.58/时`。 */
  pricePattern: /￥\s*([\d.]+)\s*\/\s*(时|小时)/,
  configCostLabel: '配置费用',
  balanceLabel: '账户余额',
  /** 确认按钮文案是「创建并开机」，不是「确认」。 */
  confirmButtonText: '创建并开机',
  cancelButtonText: '取消',
} as const

/**
 * Element Plus 通用结构。克隆动作按文字定位控件时用。
 *
 * 只放 selectors.ts 别处没有登记的结构。复选框、单选组、单选按钮、选中态类名
 * 复用 CLONE_DIALOG 与 CLONE_HOST_PAGE 里的事实，不写第二份。
 */
export const ELEMENT_PLUS = {
  /** 复选框文字。点它与点复选框等效。 */
  checkboxLabel: '.el-checkbox__label',
  /** 对话框页脚。剩余克隆次数在它的文本里。 */
  dialogFooter: '.el-dialog__footer',
  /** 禁用态类名。 */
  disabledClassName: 'is-disabled',
} as const

/**
 * 克隆创建失败时的提示条。
 *
 * 平台点「创建并开机」后的行为未实测，失败文案也未实测。只按错误态类名识别，
 * 不猜文案；命中即停止轮询，交给人核对实例是否已创建。
 */
export const CLONE_CREATE_FAILURE_NOTICE = '.el-message--error, .el-alert--error'

/** 选主机页的补充事实。见清单第 3.2 节。 */
export const CLONE_HOST_CONTROLS = {
  /** 克隆必须使用按量计费。 */
  billingPaygLabel: '按量计费',
  /** GPU 型号列表里的「全部」，它不是型号。 */
  gpuModelSelectAllLabel: '全部',
  /** 地区名以它结尾。 */
  regionSuffix: '区',
  /** 专区名以它结尾，专区不是地区。 */
  zoneSuffix: '专区',
} as const

/**
 * 实例列表第 7 列「SSH登录」。
 *
 * 未实测：实测时 5 台实例全部已关机，该列为空。以下取值来自界面文档与截图推断，
 * 见清单 1.8 节与 4 节。拿到一台运行中实例后必须实测并更新这里与清单。
 */
export const SSH_LOGIN_CELL = {
  /** 登录指令以 `ssh` 开头。 */
  loginCommandPrefix: 'ssh',
  /** 登录指令区标签文字。 */
  commandLabel: '登录指令',
  /** 密码区标签文字。 */
  passwordLabel: '密码',
  /**
   * 复制图标的类名。
   *
   * 实测（2026-11-25 真机）：第 7 列有两个复制图标，第一个复制登录指令，第二个复制密码。
   * 图标没有文字，只有 `iconfont icon-fuzhi` 两个类名，同类元素页面里很多，
   * 所以作用域必须限定在目标行的第 7 列内，再按序号取。
   */
  copyIconClassName: 'icon-fuzhi',
  /**
   * 未复制时显示在页面上的掩码字符。
   *
   * 只用于向人说明「这一列默认看不到明文」，判断不依赖它：
   * 明文从复制钩子取，不从文本猜。
   */
  maskedChars: '*•·●',
} as const

/**
 * 定时关机对话框的交互元素。
 *
 * 两点实测事实（见清单第 2.1 节）：
 * - 已关闭的对话框留在 DOM 里，只靠 display 隐藏。`.el-dialog` 会匹配到旧的隐藏对话框，
 *   动作模块用求值脚本挑出当前可见的那一个，并生成指向它的结构选择器回验后再用。
 * - 让时间输入框失焦要点标题文字。禁止点遮罩（会关掉对话框），禁止按回车（会提交表单）。
 */
export const TIMED_SHUTDOWN_DIALOG_ELEMENT = {
  /**
   * 标题文字所在的 span。实测该 span 没有 `el-dialog__title` 类，只能按结构取。
   * 它同时是让输入框失焦的无害点击位置。
   */
  titleSpan: '.el-dialog__header span',
  /** 页脚第二个按钮是「确定」。第一个是「取消」。 */
  confirmButtonOrdinal: 2,
} as const
