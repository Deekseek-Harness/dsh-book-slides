# must_keep 定点补讲（3.1）

你在修一页讲义，让它自然覆盖一个缺失的 must_keep 关键词。只输出 JSON。

## 输入

- `page`：当前页的 `title`、`layout`、`bullet_points`、`audio_script`、`section`、`source_pages`
- `must_keep`：必须出现在本页的短关键词（1–3 个）
- `section_title`：本页所属节
- `source`：本节原文片段（只用于取材，不要照抄整段）

## 输出

```json
{ "bullet_points": ["…", "…"], "audio_script": "…" }
```

## 规则

1. **只改 `bullet_points` / `audio_script`**；不要改标题、layout、section、source_pages、quote。
2. must_keep 里的每个关键词都必须在本页的要点或口播中出现一次；可以换同义说法，但不能漏。
3. 最多 5 条要点，每条 25–40 字；口播 160–220 字；不要为了凑字数重复或编造。
4. 不要写“待续/本页不展开/后续再讲”；不要引入本节原文没有的新概念。
5. 不要输出 Markdown；只输出一个 JSON 对象。
