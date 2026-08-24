# `sn-find-schema` Skill 设计方案

## 1. 背景 / 问题

`sn_list_tables` 只支持按 `name` 做前缀/后缀/子串过滤，返回结果无相关性排序。真实使用场景通常是「只知道业务概念，不知道技术名」，例如「存这个 UI 聊天面板的表是哪张」，现在只能靠模型肉眼扫全量表名列表。

同样的缺口也存在于字段层面（`sys_dictionary`）——很多时候用户想找的其实是字段而不是表。

ACL / Business Rule 也有类似的「先要知道锚点（表名）才能查」的限制（`sn_get_security_info`、`sn_diagnose_mutation` 都是 `tableName` 强绑定），但匹配对象是脚本/条件内容而非 label，属于不同的问题，**本次不做**，见第 6 节。

## 2. 决策记录：Skill，不是 Tool

讨论过做成新 MCP tool（内置模糊匹配/排序算法）还是做成 skill（编排现有工具 + 让调用方自己 grep），最终选 **skill**，原因：

1. **和已定下的设计哲学一致**——调用这个能力的本身就是 AI（Claude Code）。把候选检索做扎实、把原始可搜索文本吐出来，排序/语义判断交给调用方自己做，比在工具内部再嵌一层排序算法（甚至模型）更「AI-native」。做成 skill 相当于把这个原则贯彻到底：连排序算法都不需要写，直接让 Claude 用 grep + 自己的语义理解去找。
2. **仓库里有直接先例**——`sn-dependency-graph` 就是「几个通用只读能力 + 本地缓存 + 分步指导」的 skill，形状高度相似，可以照抄它的结构（cache 路径约定、SKILL.md 的 When to use/When NOT to use 写法）。
3. **零新增维护成本**——不用引入模糊匹配依赖（如 `fuse.js`），不用在 MCP server 里管缓存/刷新状态，全部用现成的 `sn_query_records` + `Write`/`Read` + `Grep`/`Bash` + `sn_get_table_schema` 编排。

代价：skill 只在支持 skill 机制的 host（Claude Code 这类）里可见，对纯 MCP 协议客户端不可用。当前场景下这个代价可接受。

## 3. 范围

**做：**
- 新 skill `sn-find-schema`：给一段自然语言描述，找出最相关的表和/或字段。

**不做：**
- 不碰 `sn_list_tables`——它仍是「已知表名局部特征做精确枚举」的最快路径。
- 不做 ACL / Business Rule 的语义搜索——匹配对象是脚本/条件内容，是完全不同的检索问题，未来可作为独立 skill（暂定 `sn-find-logic`）。
- 不做数据记录（业务数据行）的语义搜索。
- 不引入 embedding / 向量检索 / 固定同义词词典——让 Claude 自己联想同义词/关键词变体去 grep，比维护一份静态词典更聪明、成本更低。

## 4. Skill 设计

### 4.1 SKILL.md frontmatter（草案）

```yaml
---
name: sn-find-schema
description: Find a ServiceNow table or field by natural-language business
  description (not by exact technical name). Builds/reuses a local
  name+label snapshot of sys_db_object and sys_dictionary, then greps it
  with self-generated keyword variants. Use when the user describes a
  concept ("the table behind this chat panel", "where is the escalation
  flag stored") rather than naming a table/field directly.
allowed-tools: Read, Write, Grep, Bash,
  mcp__plugin_now-mcp_now-mcp__sn_query_records,
  mcp__plugin_now-mcp_now-mcp__sn_get_table_schema
---
```

### 4.2 流程

1. **检查本地 snapshot 是否存在且新鲜**（见 4.4 新鲜度策略）。新鲜就跳到步骤 3。
2. **不存在/过期 → 重新生成 snapshot**：
   - `sn_query_records(tableName="sys_db_object", fields=["name","label"], limit=<全量或分页>)`
   - `sn_query_records(tableName="sys_dictionary", query="elementISNOTEMPTY", fields=["name","element","column_label"], limit=<全量或分页>)`
   - 两次查询结果写入本地 snapshot 文件（格式见 4.4）。
3. **生成关键词变体**：Claude 根据用户描述，自己联想若干中英文关键词/同义词（例如「聊天面板」→ `chat`, `conversation`, `panel`, `聊天`, `会话`），不依赖固定词典。
4. **grep 本地 snapshot**：对每个关键词变体跑 `grep -i`（或一次性用 `-E "kw1|kw2|..."` 合并），只把命中的行读入上下文，而不是整份文件。
5. **（可选）二次确认**：候选表/字段找到后，用 `sn_get_table_schema` 或 `sn_get_table_structure_from_data` 验证候选表确实存在、结构合理，避免把 snapshot 里过期/已删除的行当真。
6. **回复用户**：列出候选（表名/字段名 + label + 命中关键词），附上是否做过二次确认，而不是只甩一个「答案」。

### 4.3 Snapshot 文件格式与路径

参考 `sn-dependency-graph` 的缓存路径约定：

```
~/.claude/sn-graph-cache/<instance>/schema-snapshot/tables.tsv
~/.claude/sn-graph-cache/<instance>/schema-snapshot/fields.tsv
```

用 TSV（而不是 JSON）是为了直接支持行级 grep，且人眼可读：

```
tables.tsv:   name\tlabel
fields.tsv:   table_name\telement\tcolumn_label
```

每个文件配一个同目录的 `.meta.json` 记录生成时间戳，供新鲜度判断使用（同 `sn-dependency-graph` 现有做法）。

### 4.4 新鲜度 / 刷新策略

- 默认 TTL：例如 24 小时（表结构变动频率远低于数据），超过则视为过期，触发重新生成。
- 提供「强制刷新」的口头触发方式（用户说「重新拉一下」或 skill 显式支持一个 refresh 参数）。
- 明确告知用户 snapshot 是「某时刻的快照」，新建/改名的表在下次刷新前不可见——这一点要写进 SKILL.md 的说明里，不能藏起来。

### 4.5 AI-native 原则（沿用）

- 不做 embedding/向量检索：候选词表规模有限（几千条 label），grep + 语义联想已经够用。
- 不在流程里嵌入二次 LLM 调用去"猜"答案（对照 supernow-main 的 `ai:` 反面案例——凭知识直接猜表名、不校验，容易幻觉）。所有候选都来自真实 snapshot 数据，且推荐做步骤 5 的二次确认。
- 智能都在调用方（Claude）这一侧：关键词联想、候选取舍、最终判断，都不固化成算法或词典。

## 5. 与现有工具/skill 的关系

- `sn_list_tables`：保留，服务「已知 name 局部特征」场景，SKILL.md 的 "When NOT to use" 里应指出「已经知道表名/前缀，直接用 `sn_list_tables`，不需要这个 skill」。
- `sn_get_table_schema` / `sn_get_table_structure_from_data`：作为找到候选后的确认步骤复用，不重新实现。
- `sn-dependency-graph`：结构上的参照对象（cache 路径、SKILL.md 写法），两者可以在文档里互相提及，但功能不重叠。

## 6. 后续可扩展方向（本次不做）

- `sn-find-logic`（暂定名）：针对 Business Rule / ACL 的语义搜索，匹配对象是脚本内容、condition，需要单独设计，不与本 skill 合并。
- 跨 session 的「哪个候选最终被选中」记忆（轻量学习信号），目前不做。

## 7. 实现计划（预估文件清单）

```
plugins/now-mcp/skills/sn-find-schema/
  SKILL.md
  references/
    snapshot-queries.md   # 两条 sn_query_records 调用模板 + 字段说明
```

不新增 MCP tool、不新增依赖。

## 8. 待确认的开放问题

1. Snapshot 生成是否要分页处理超大实例（`sys_dictionary` 字段行数可能上万），还是先假设单次 `limit` 拉全量、超限再优化？
2. TTL 默认值定多少合适（24 小时 vs 更短）？是否需要让用户可配置？
3. 中文关键词联想完全交给 Claude 自己发挥，是否需要在 SKILL.md 里给一两个示例 prompt 引导它多想几个变体，避免只 grep 一个词就放弃？
4. 二次确认步骤（4.2 第 5 步）是否强制要求，还是仅在候选模糊/多个高分候选时才做？
