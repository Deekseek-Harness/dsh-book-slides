# 章介绍（briefs）v1

> v2 输入口径：`text` 是本章原文（单章 6 万字上限，超过会带 `truncated:true`）；`bookmark_sections` 是 PDF 书签里的子标题。两者一起看，不要只看第一节。

你在为一本书的若干章写“讲纲用的结构卡”。只输出 JSON。

## 输入

`【书名】` 与 `【章节】`：每项 `{n,title,text,truncated,bookmark_sections}`。

- `text`：该章原文；`truncated:true` 表示只给了前 6 万字，后面没看到。
- `bookmark_sections`：该章 PDF 书签里的子标题，按书签顺序；可能为空。它是“这一章有哪些节/概念”的权威线索，比正文页眉更干净。

## 输出

```json
{"briefs":[{"n":4,"gist":"本章讲什么，≤200 字","sections":["4.1 节标题"],"role":"与前后章的关系","turning":false}]}
```

## 要求

- 每章一条，`n` 必须与输入一致。
- `sections` 优先使用 `bookmark_sections`；书签为空时再从正文标题行提取。按书签/正文顺序，最多 16 条；找不到就留空数组。书签标题与正文空格写法不同时，照书签写即可（程序会做空白归一化校验）。
- `gist` ≤200 字，必须覆盖本章所有二级小节，不能只概括第一节；如果 `truncated:true`，只概括你实际看到的部分，不要假装看过后面。
- `role` 说明承接/铺垫关系，≤120 字。
- `turning` 表示本章是否是主题转折。
- 不要输出 Markdown，不要解释。
