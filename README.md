# dsh-fs-search-plus

增强 DSH 内置的 `glob` / `grep`。不替换工具，不改变结果的格式和上限。

DSH 自带的两个搜索工具用内置 ripgrep，参数是固定的。这个插件在参数表里加字段，并在发起搜索时把字段翻译成 ripgrep 参数。

## 安装

```sh
dsh plugin --profile desktop add github:RicardoYan/dsh-fs-search-plus#v0.1.2
```

Web 端把 `desktop` 换成你的 profile 名（一般是 `web`）。装完重启 DSH。

卸载：`dsh plugin --profile desktop remove dsh-fs-search-plus`

装完不用配置，所有行为通过工具参数控制。

## `glob`

- **返回最新的在前**。原来按修改时间**升序**排，而结果只保留前 100 条，所以拿到的是**最旧的 100 条**。现在改为降序，和工具自己的描述一致。
- **扫描快得多**。原来的排序参数会让 ripgrep 退化成单线程；去掉后正常并行，排序在插件里做。不管命中多少条都照常排序。
- **默认跟随符号链接和 Windows junction**（新增 `follow` 参数）。

## `grep`

新增这些参数，都不传就等于原来的行为：

| 参数 | 类型 | 说明 |
|---|---|---|
| `follow` | boolean | 跟随符号链接，**默认 `true`** |
| `ignoreCase` | boolean | 忽略大小写 |
| `after` | number | 每个匹配后附几行 |
| `before` | number | 每个匹配前附几行 |
| `context` | number | 前后各附几行 |
| `type` | string | 只搜某一种文件类型，如 `ts`、`py` |

`after` / `before` / `context` 没有上限：ripgrep 会按文件长度自然截断，超出工具单次输出上限时会明确报错。

## 要注意的三点

**上下文行看起来和匹配行一样。** 打开 `after` / `before` / `context` 后，附带的行也显示成 `Line N: <文本>`，并且计入 "Found N matches"。这是为了让它们真的能被看到——工具原本会丢弃这类行，只加参数不显示任何东西。

**`follow` 会把链接里的文件也搜进来。** 如果仓库用 pnpm，`node_modules` 里的依赖包本身是链接，跟着走会让结果大很多；对 `glob **/*` 这种全量查询，可能超出工具单次输出的上限而报错。遇到就收窄 `pattern`，或传 `follow: false`。

**树里有断链时也能正常返回结果。** 跟随链接后，任何一个断链都会让底层工具把整次搜索判为失败；插件只在这种情况把结果救回来。搜索目录不存在、正则写错仍然照常报错。

## 适用版本

`@deepseek-ai/dsh` `>=0.2.1-rc.1 <0.3.0-0`。依赖 DSH 的内部接口，改用其他版本前先确认。

## 许可证

MIT
