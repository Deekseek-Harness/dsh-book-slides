# 讲纲（plan）v1

你在把一本书的一个 Part 规划成 N 讲。只输出 JSON。

## 输入

`【Part】` 标题与章节号；`【章介绍】` 每章的 `gist/sections/role/turning`；`【容量】` 每讲目标 6 万字、最多 6 章、最多 8 讲。

## 输出

```json
{
  "throughline": "本部分主线，一句话",
  "lectures": [
    {"n":1,"chapters":[4,5,6,7,8],"title":"第 1 讲标题","goal":"本讲目标","in":"已知","out":"讲完应会"}
  ],
  "seams": [
    {"from":1,"to":2,"concept":"衔接概念","sentence":"≤60 字的接缝句"}
  ],
  "terms": [
    {"name":"定义域","forbid":["定义区间"]}
  ],
  "cut_notes": []
}
```

## 硬约束

- 讲次从 1 连续；所有 Part 章号必须恰好出现一次，不重叠、不遗漏。
- 每讲 1–6 章；每讲字数尽量 ≤6 万，工程上限 8 万。
- `seams` 数量必须等于讲数 −1；`from=i`、`to=i+1`。
- `sentence` ≤60 字，讲 i+1 的封面首句会逐字使用它。
- `terms[].name` 必须来自章标题或章介绍；`forbid` 是不允许的写法。
- 不要输出 Markdown，不要解释。
