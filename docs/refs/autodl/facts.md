# AutoDL「复制实例」与两套 API 的区别：事实核实

核实日期：2026-11-24。来源均为 autodl.com 官方帮助文档页面正文；页面原文用「」标出，未改写。
术语说明：官方文档与控制台均使用「克隆实例」，全部文档中未出现「复制实例」。

## 1. 功能名称与出处

- 名称：**克隆实例**。页面：https://www.autodl.com/docs/migrate_instance_2/（页面标题「迁移实例(同地区)」）。
- 原文：
  - 「Step0. 原实例关机」
  - 「Step1. 克隆实例」
  - 「克隆实例将以当前实例的系统盘为模板创建新实例，如果需要同时拷贝数据盘，那么请勾选数据盘选项，数据盘将在系统盘克隆完成后开始拷贝。」
  - 「点击克隆实例后，在创建实例页面选择一台新主机创建实例即可。」
- 控制台入口截图（页面图）：实例「更多」菜单中为「克隆实例 新」。图：https://www.autodl.com/docs/assets/2023-05-25-20-20-26-image.png
- 「复制实例」在官方文档站搜索索引（477 条）中 0 命中。

## 2. 是否有克隆/复制的 API 端点

- **两套 API 文档中均无该端点。**
- 标准容器实例 API 页面正文只有 2 个端点小节：`POST /api/v1/dev/wallet/balance`、`POST /api/v1/dev/exclusive_nfs/mount`。
- 容器实例Pro API 页面端点全集：`/api/v1/dev/instance/pro/create`、`/snapshot`、`/status`、`/list`、`/power_on`、`/power_off`、`/release`、`/image/save`、`/image/private/list`，无克隆端点。
- Pro 创建实例请求字段中无源实例/快照字段（字段见 common_api 与 instance_pro_api 归档）。

## 3. 系统盘与数据盘是否一起复制

- 系统盘：作为模板一并克隆。原文「克隆实例将以当前实例的系统盘为模板创建新实例」。
- 数据盘：默认不自动带，需勾选。原文「如果需要同时拷贝数据盘，那么请勾选数据盘选项，数据盘将在系统盘克隆完成后开始拷贝。」
- 控制台对话框「克隆实例」中「需要克隆的数据：系统盘（勾选且置灰）、数据盘」，底部「今天剩余克隆次数：3次」。图：https://www.autodl.com/docs/migrate_instance.assets/image_20250311170312.png
- 数据盘路径与容量见 https://www.autodl.com/docs/env/「数据盘 /root/autodl-tmp 50GB起 可扩容」，且「不能保存至镜像中」。

## 4. 被克隆实例的状态要求

- 必须关机。原文「Step0. 原实例关机 先关机原实例。」
- 克隆对话框原文「克隆后源实例不受影响，不会释放也不会清理数据」。

## 5. 能否指定目标 GPU 规格、地区、实例名

- 文档只写到「点击克隆实例后，在创建实例页面选择一台新主机创建实例即可」：目标主机（决定地区与 GPU 规格）在创建实例页面选。
- 克隆对话框可选项只有「需要克隆的数据：系统盘 / 数据盘」，无实例名、无规格、无地区选择。
- 文档未给出「克隆时可指定 GPU 规格/地区/实例名」的原文：**未查到**。页面把克隆放在「迁移实例(同地区)」下，跨地区迁移另走保存镜像/跨实例拷贝/网盘。

## 6. 容器实例与容器实例Pro 区别表（https://www.autodl.com/docs/instance_pro/）

| 对比项目 | 容器实例 | 容器实例Pro |
| --- | --- | --- |
| 是否支持API | 「无」 | 「有」 |
| 使用体验（开机方式） | 「系统盘和数据盘均使用本地磁盘，和物理机绑定，机器无 GPU 时需等待或克隆」 | 「存算分离，和物理机非绑定关系，只要总GPU库存充足随时开机」 |
| 磁盘容量和计费 | 「默认系统盘 30GB + 数据盘 50GB，默认容量免费，数据盘可付费扩容，系统盘不支持扩容」 | 「系统盘 30GB，最大可扩容至 500GB，需付费；无数据盘（可能会支持）」 |
| 磁盘 IO | 「本地磁盘，多数为NVMe磁盘，IO 性能高」 | 「系统盘为网络存储。磁盘 IO 相对容器实例的本地NVMe磁盘更低，但相对文件存储更高」 |
| 实例释放周期 | 「连续关机 15 天后释放」 | 「连续关机 60 天后释放」 |
| 存储挂载 | 「支持文件存储、高速文件存储挂载」 | 「支持文件存储挂载」 |

- 价格：表内无数字价格，只有「默认容量免费」vs「需付费」，及劣势行「付费磁盘的价格要高于容器实例」。
- 计费方式：该表无「计费方式」行。Pro API 原文「默认以按量计费方式创建实例，暂不支持选择其他计费方式创建实例」；标准实例有按量计费/包年包月两种（控制台「转包年包月」菜单，见 https://www.autodl.com/docs/change_billing_method/）。
- 开机方式补充：Pro API 开机请求原文「gpu：有卡开机, 暂不支持API以无卡模式开机」；标准实例有无卡模式（https://www.autodl.com/docs/save_money/「同一主账号同时只能有一个无卡模式实例」）。

## 7. 标准容器实例 API（common_api）完整端点清单

来源 https://www.autodl.com/docs/common_api/

1. `POST /api/v1/dev/wallet/balance`：获取账户余额，请求参数无。
2. `POST /api/v1/dev/exclusive_nfs/mount`：切换专用NFS/文件存储，参数 `data_center`、`mountable`。

注意：页面还有「保存镜像」标题但其下无正文；该标题前另有一个空标题（`<h2 id="_5"></h2>`）。故「保存镜像」小节没有给出任何端点。

## 8. 鉴权与金额单位

- 鉴权方式相同：HTTP header `Authorization` 直接放 token。标准页面原文「`headers = {"Authorization": "token"}`」；Pro 页面原文「`headers = {"Authorization": "填写您的token"}`」。
- token 位置措辞不同：标准「token获取位置： 控制台 -> 设置 -> 开发者Token」；Pro「Token获取位置：请登录 www.AutoDL.com 访问控制台 → 账号 → 设置 → 开发者Token」。
- 金额单位：标准 API 三个余额字段备注均为「当前余额。除以1000等于元」「累计消费金额。除以1000等于元」「当前代金券可用余额。除以1000等于元」；Pro 页面 `payg_price` / `origin_pay_price` 只写「折扣后的按量计费价格」「折扣前的按量计费价格」，**无单位标注**。

## 9. 标准容器实例是否有定时关机 API

- **无。** https://www.autodl.com/docs/common_api/ 正文只有上述 2 个端点，无定时关机小节。
- Pro API 也无设置定时关机的端点；仅 `/list` 返回 `timed_shutdown_at` 字段。
- 定时关机只出现在控制台界面（见 https://www.autodl.com/docs/migrate_instance/ 原文「可以[设置定时关机]」及实例列表「设置定时关机」）。

## 10. 标准实例 SSH 登录方式

- 来源 https://www.autodl.com/docs/ssh/
- 原文「开机实例后，找到SSH登录指令」；「在您的本地终端中输入该命令，输入密码进行登录。（注意：密码不会显示任何字符，正确输入或鼠标右击粘贴后回车即可）」。
- 密码位置：页面正文未写明。同页截图（https://www.autodl.com/docs/ssh.assets/image_20250310152031.png）标注控制台实例列表「SSH登录」列下有「登录指令」与「密码」（掩码，带复制按钮）。
- 支持公钥，原文「从控制台-容器实例->设置密钥登录入口进去配置SSH公钥。这样重启后或新创建的实例都能免密码登录，减少复制SSH登录密码的麻烦。」并给出 `ssh-keygen -t rsa` 生成方法。
- 标准 API 无实例详情端点，故没有 `root_password` 字段；Pro API `/snapshot` 返回 `"root_password": "..."  // ssh密码`。

## 归档文件

- https://www.autodl.com/docs/common_api/ 正文：`common_api.md`
- https://www.autodl.com/docs/instance_pro_api/ 正文：`instance_pro_api.md`
