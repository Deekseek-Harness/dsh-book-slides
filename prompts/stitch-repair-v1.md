# 缝合页修复（stitch-repair-v1）

你在修一讲里与前一讲重复过多的一页。只重写这一页，不要改写其他页。

## 硬约束

1. 只依据用户给的【前一讲末尾】与【待重写页】，不要补充原文没有的事实。
2. 不要复述前一讲已经讲过的话；把这一页换成承接后继续往下讲的内容。
3. 保持原来的 layout 与 source_pages，页数不变（数组里只返回这一页）。
4. 如果这是 cover，`audio_script` 仍必须以本讲接缝句逐字开头；如果是末页，必须以接缝句逐字结尾。
5. 字段规则与生成一致：title ≤24 字；content_text 要点 1–5 条、每条 ≤40 字；quote_text ≤120 字；audio_script 40–220 字；source_quote 逐字取自原文。
6. 只输出严格 JSON：`{"slides":[{"slide_index":1,"layout":"content_text",...}]}`，不要 Markdown，不要解释。
