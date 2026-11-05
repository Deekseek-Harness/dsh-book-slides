# 讲纲元信息（超长章拆分）v1

输入已经由程序拆好的讲次（含 `slice`），你只补主线、接缝与术语，不改讲次和章划分。只输出 JSON。

## 输出

```json
{
  "throughline": "本部分主线",
  "seams": [{"from":1,"to":2,"concept":"衔接概念","sentence":"≤60 字"}],
  "terms": [{"name":"定义域","forbid":["定义区间"]}]
}
```

## 硬约束

- `seams` 数量 = 讲数 − 1；`from=i`、`to=i+1`。
- `sentence` ≤60 字。
- `terms[].name` 必须来自章标题或章介绍；`forbid` 是不允许的写法。
- 每讲可能包含多个 Item/小节；`lectures[].sections` 是该讲实际覆盖的标题，必须按它概括，**不得把整章缩成单一 Item**，也不得虚构未出现的 Item 编号。
- `lectures[].scope.first/last` 是该讲首尾标题；`throughline` 必须同时提到第一讲的 `scope.last` 和最后一讲的 `scope.last`（或它们的 Item 编号）。
- 接缝 `i` 必须提到第 `i+1` 讲的 `scope.first`（或它的 Item 编号），不要用“同一 Item”这类原文未给出的说法。
- 不要改 lectures，不要输出 Markdown。
