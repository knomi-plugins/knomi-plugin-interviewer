'use strict'

/**
 * interviewer 应用阶段插件
 * 内化是"记住"，应用是"会用"。本插件把文档标题/知识点转成开放式应用问题：
 *   "假设你要向新同事解释「X」，你会怎么讲？"
 * 以 short_answer 入题库（生成效应：输出比输入记得牢），做题时用户自评 0-5，
 * 自评直接回流 SM-2 调度与掌握度。
 */

const fsp = require('fs/promises')
// 接地校验：平台共享纯函数库注入（B1' T1-2，唯一权威实现在 electron/shared/plugin-stdlib，
// 经沙箱 knomi.stdlib 只读命名空间下发 + sha256 对账）。偏斜守卫：缺面（旧平台+新插件窗口）
// 时预检放行不阻断，宿主终检兜底。禁止再持本地副本。
const std = (typeof knomi !== 'undefined' && knomi.stdlib) || null
const isGroundedIn = (std && std.grounding && std.grounding.isGroundedIn) || (() => true)

const PLUGIN_ID = 'interviewer'

/**
 * 方法论题卡（九式，覆盖输出式学习的经典套路）：
 * 费曼讲解 / 应用场景 / 价值论证 / 电梯演讲 / 教长辈大白话 / 反例辨析 / 决策推演 / 排查演练 / 类比挑战。
 * 每轮随机洗牌取卡——多轮陪练不重样（趣味优先）。
 * 题式规范 v2（0.5.0 起）：题干不带出处括注（「（出自《…》）」）——出处由 sourceSnippet
 * （主题「X」出自《Y》）与题目库「来源」列表达，题干保持纯净可读。
 */
const QUESTION_TEMPLATES = [
  (topic) => `假设你要向完全没有背景的新同事解释「${topic}」，你会怎么讲？请用自己的话写出要点。`,
  (topic) => `请举一个「${topic}」在实际工作中的应用场景，并说明它解决了什么问题。`,
  (topic) => `如果有人质疑「${topic}」的价值，你会如何用两三句话论证？`,
  (topic) => `电梯演讲挑战：用 30 秒向一位忙碌的面试官讲清「${topic}」是什么、为什么重要。`,
  (topic) => `费曼检验：用大白话向一位完全不懂这一行的长辈解释「${topic}」，不许用行话。`,
  (topic) => `反例辨析：说一个对「${topic}」常见的错误理解，并讲清楚它为什么错。`,
  (topic) => `决策推演：如果要在真实项目里用上「${topic}」，你会怎么权衡收益与代价、怎么拍板？`,
  (topic) => `排查演练：如果「${topic}」的表现不符合预期，你会按什么顺序定位原因？`,
  (topic) => `类比挑战：用一个贴切的日常生活类比，讲清「${topic}」的核心原理。`
]

/** 主题净化与质量门（题卡出题锚门槛）：
 *  ① 剥离编号前缀（「1. 」「03. 」「(2)」「一、」——编号不是知识）；
 *  ② 拦截泛型章节名（简介/概述/总结/目录…——无考点，出成题干是废题）；
 *  ③ 长度与纯编号防线。实证坏例：「1. 简介」→ 用户反馈 2026-09-17。返回 null = 不可用作题锚 */
const GENERIC_TOPIC_RE = /^(简介|概述|引言|前言|背景|目录|总结|小结|结语|结论|附录|参考|参考资料|参考文献|扩展阅读|延伸阅读|说明|介绍|使用说明|注意事项|环境准备|快速开始|开始使用|入门|安装|部署|常见问题|FAQ|术语表|正文|整体结构|目录结构|示例代码?|源码结构)$/
function sanitizeTopic(raw) {
  const stripped = String(raw || '')
    .replace(/^[\s\d一二三四五六七八九十百]+[.、)．:：]\s*/, '')
    .replace(/^\s*[(（]\s*\d+\s*[)）]\s*/, '')
    .trim()
  if (stripped.length < 2 || stripped.length > 40) return null
  if (GENERIC_TOPIC_RE.test(stripped)) return null
  if (/^[\d\s.、]+$/.test(stripped)) return null
  return stripped
}

/** 模板洗牌（rng 注入可测；缺省真随机——每轮陪练换一套题卡） */
function shuffledTemplates(rng = Math.random) {
  const arr = [...QUESTION_TEMPLATES]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** 宽松 JSON 解析（兼容围栏/前后缀；LLM 输出容忍） */
function looseParseJson(raw) {
  const text = String(raw || '').replace(/```(json)?/gi, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('输出不含 JSON 数组')
  return JSON.parse(text.slice(start, end + 1))
}

/**
 * LLM 深度陪练出题（0.7.0）：材料 → 开放式应用题 → 接地 + 盲答双闸门 → 入库署名。
 * 出题规范：每题锚定一个主题，要求"输出/讲解/权衡"类任务；参考答案给要点式评分方向；
 * sourceSnippet 逐字摘自材料（接地校验拒编造）。llm/验证不可用或全部被拒时返回 null，
 * 调用方降级九式题卡（模板题退化为保底而非主力——2026-09-18 出题质量迭代）。
 * @returns {Promise<{questions: object[], rejected: string[], mode: 'llm'} | null>}
 */
async function tryLlmGenerate(context, { items, count }) {
  if (!context.llm || typeof context.llm.complete !== 'function') return null
  // 材料：每个出题锚对应文档读一次（cap 2400 字/篇、总量 8000 字）
  const contentByDoc = new Map()
  let budget = 8000
  for (const it of items) {
    if (contentByDoc.has(it.docId) || budget <= 0) continue
    let content = ''
    try { content = (await context.readFile(it.docPath)) || '' } catch { content = '' }
    content = content.slice(0, Math.min(2400, Math.max(budget, 0)))
    budget -= content.length
    contentByDoc.set(it.docId, content)
  }
  const material = items
    .map((it) => {
      const c = contentByDoc.get(it.docId) || ''
      return c ? `【主题：${it.topic}｜出自《${it.docTitle}》】\n${c}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
  if (!material) return null

  const system = [
    '你是 Knomi 的应用陪练官：把知识点变成开放式应用问题，强迫用户输出而不是被动重读。',
    '出题纪律：①每题锚定给定的一个主题，构造"讲解/应用场景/权衡决策/排查演练/反例辨析"类任务，禁止名词解释式的送分题；',
    '②answer 给要点式参考答案与自评方向（讲清"是什么/为什么/怎么用"的程度标准）；',
    '③sourceSnippet 必须逐字摘自对应主题的材料（连续片段，禁止改写拼接——落库有接地校验，不符即拒收）；',
    `④只输出一个 JSON 数组（不要解释、不要代码围栏），恰好 ${count} 项，每项：`,
    '{"topic":"锚定的主题","question":"题干（不带出处括注）","answer":"要点式参考答案","explanation":"一句考察意图","sourceSnippet":"逐字原文片段"}。',
  ].join('')
  const user = `出题主题（共 ${items.length} 个锚，生成 ${count} 题轮转覆盖）：\n${items.map((it, i) => `${i + 1}. ${it.topic}`).join('\n')}\n\n材料：\n${material}`

  let rawQuestions
  try {
    const raw = await context.llm.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      json: true,
      temperature: 0.4,
      maxTokens: 2048,
      timeoutMs: 90000,
    })
    rawQuestions = looseParseJson(raw)
  } catch {
    return null
  }
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null

  // 盲答验证（可用时）：独立判卷逐题过堂；不可用 → verified=0 如实标注
  const verdictByIndex = new Map()
  let verifyAvailable = false
  if (typeof context.verifyQuestions === 'function') {
    try {
      const vr = await context.verifyQuestions(rawQuestions.slice(0, count).map((q) => ({
        type: 'short_answer',
        question: String(q && q.question || ''),
        answer: String(q && q.answer || ''),
        sourceSnippet: String(q && q.sourceSnippet || ''),
      })))
      if (vr && vr.available !== false) {
        verifyAvailable = true
        for (const v of (vr.verdicts || [])) {
          const idx = Number(v && v.index)
          if (idx >= 1 && idx <= Math.min(rawQuestions.length, count)) verdictByIndex.set(idx - 1, v)
        }
      }
    } catch { verifyAvailable = false }
  }

  const questions = []
  const rejected = []
  for (let i = 0; i < Math.min(rawQuestions.length, count); i++) {
    const q = rawQuestions[i] || {}
    const it = items[i % items.length]
    const content = contentByDoc.get(it.docId) || ''
    const label = `第 ${i + 1} 题`
    if (!q.question || !q.answer || !q.sourceSnippet) { rejected.push(`${label}：字段缺失`); continue }
    if (!content || !isGroundedIn(String(q.sourceSnippet), content)) { rejected.push(`${label}：原文片段与原文不符`); continue }
    const verdict = verdictByIndex.get(i)
    if (verifyAvailable && verdict && verdict.verdict && verdict.verdict !== 'pass') {
      rejected.push(`${label}：盲答验证未通过（${verdict.verdict}）`); continue
    }
    const verified = verifyAvailable && verdict && verdict.verdict === 'pass' ? 1 : 0
    const sourceSnippet = String(q.sourceSnippet)
    // P3-S3b questions 表退役降级包（2026-09-24）：插入失败（表已退役/不可写）→ 不入库直接练
    // （作答按文档记账 practice_attempts；题即练即弃，无题库污染面）
    let result
    try {
      result = await context.insertQuestion({
        documentId: it.docId,
        type: 'short_answer',
        question: String(q.question).trim(),
        answer: String(q.answer).trim(),
        explanation: String(q.explanation || '').trim(),
        sourceSnippet,
        knowledgePointTitle: String(q.topic || it.topic).trim(),
        pluginId: PLUGIN_ID,
        verified,
        generator: '陪练官',
      })
    } catch (err) {
      result = { id: `inst-${Date.now()}-${i}`, created: true, duplicate: false, degraded: true, reason: `入库不可用: ${(err && err.message) || err}` }
    }
    if (result.created || result.duplicate) {
      questions.push({
        id: result.id, documentId: it.docId, documentPath: it.docPath || null,
        knowledgePointTitle: String(q.topic || it.topic).trim(),
        type: 'short_answer',
        question: String(q.question).trim(),
        answer: String(q.answer).trim(),
        explanation: String(q.explanation || '').trim(),
        sourceSnippet, pluginId: PLUGIN_ID,
        verified, generator: '陪练官',
        duplicate: result.duplicate,
      })
    } else {
      rejected.push(`${label}：${result.reason || '入库被拒'}`)
    }
  }
  if (questions.length === 0) return null
  return { questions, rejected, mode: 'llm' }
}

/**
 * 生成链（start_interview 与 start_weak_interview 共用，0.7.0 起两段式）：
 * LLM 深度陪练优先（接地+盲答双闸门、逐题署名）；llm 不可用/全部被拒 →
 * 降级九式题卡（模板题退化为保底，署名「陪练官·题卡」区分质量预期）。
 * @param {object} ctx 插件上下文
 * @param {object} opts
 * @param {Array<{topic: string, docTitle: string, docId: string, docPath?: string}>} opts.items 出题锚（主题与文档一一对应）
 * @param {number} opts.count 题数
 * @returns {Promise<{questions: object[], rejected: string[], mode: 'llm'|'template'}>}
 */
async function generateInterviewQuestions(context, { items, count }) {
  const llm = await tryLlmGenerate(context, { items, count })
  if (llm) return llm

  const questions = []
  const rejected = []
  const tpls = shuffledTemplates()
  for (let i = 0; i < Math.min(count, items.length); i++) {
    const it = items[i % items.length]
    const tpl = tpls[i % tpls.length]
    const question = tpl(it.topic)
    const answer = `参考方向：结合《${it.docTitle}》中关于「${it.topic}」的原文要点作答；自评标准——能讲清"是什么/为什么/怎么用"给 4-5 分。`
    const explanation = '应用题考察输出能力：讲得清楚才算掌握。'
    const sourceSnippet = `主题「${it.topic}」出自《${it.docTitle}》`
    // P3-S3b 降级包：同上——表退役后不入库直接练
    let result
    try {
      result = await context.insertQuestion({
        documentId: it.docId,
        type: 'short_answer',
        question,
        answer,
        explanation,
        sourceSnippet,
        pluginId: PLUGIN_ID,
        generator: '陪练官·题卡'
      })
    } catch (err) {
      result = { id: `inst-${Date.now()}-${i}`, created: true, duplicate: false, degraded: true, reason: `入库不可用: ${(err && err.message) || err}` }
    }
    if (result.created || result.duplicate) {
      questions.push({
        id: result.id, documentId: it.docId, documentPath: it.docPath || null,
        knowledgePointTitle: it.topic,
        type: 'short_answer', question,
        answer, explanation, sourceSnippet, pluginId: PLUGIN_ID,
        generator: '陪练官·题卡',
        duplicate: result.duplicate
      })
    } else {
      rejected.push(result.reason || '入库被拒')
    }
  }
  return { questions, rejected, mode: 'template' }
}

module.exports = {
  id: PLUGIN_ID,
  name: '应用陪练官',
  version: '0.8.0',
  description: '应用阶段：LLM 深度陪练出题（接地+盲答双闸门，署名可辨），LLM 不可用降级九式题卡保底',
  QUESTION_TEMPLATES,
  shuffledTemplates,
  sanitizeTopic,

  activate(context) {
    context.registerAgentTool(
      {
        name: 'start_interview',
        description: '基于知识库文档的标题/章节/知识点生成开放式"应用题"（讲解题、场景题、论证题），入题库后立即进入做题会话；作答采用自评（0-5）回流掌握度。用户想"检验自己会不会讲/会不会用/模拟面试"时使用。',
        parameters: {
          type: 'object',
          properties: {
            documentPath: { type: 'string', description: '目标文档路径；缺省取最近更新的文档' },
            count: { type: 'number', description: '题数，默认 3，上限 8' }
          }
        }
      },
      async (args) => {
        const count = Math.min(Math.max(Number(args.count) || 3, 1), 8)
        const docs = (await context.getDocuments()) || []
        if (!docs.length) return { output: '', error: '知识库为空，请先采集/添加文档（如剪藏一个网页，或对小诺说「把这段话存到知识库」）' }

        let doc = null
        if (args.documentPath) {
          const norm = String(args.documentPath).replace(/\\/g, '/').toLowerCase()
          doc = docs.find((d) => String(d.filePath || '').replace(/\\/g, '/').toLowerCase() === norm) || null
          if (!doc) return { output: '', error: `未找到文档: ${args.documentPath}` }
        } else {
          doc = [...docs].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
        }

        // 出题素材：优先已提取的知识点，退化为文档章节标题
        let topics = []
        try {
          const kps = (await context.getKnowledgePoints(doc.id)) || []
          topics = kps.map((k) => k.title)
        } catch { /* 知识点不可用则退化 */ }
        if (topics.length === 0) {
          let content = ''
          try { content = await fsp.readFile(doc.filePath, 'utf-8') } catch { content = '' }
          topics = [...content.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim())
        }
        topics = [...new Set(topics.map(sanitizeTopic).filter(Boolean))]
        if (topics.length === 0) {
          // 阶段断点引导（S3）：报错必须可执行——告诉用户下一步具体做什么才能解锁本能力
          return {
            output: '',
            error: `《${doc.title}》没有可用的标题/知识点（泛型章节名如「简介/概述」已过滤），无法生成应用题。下一步：先对小诺说「根据《${doc.title}》出几道题」——出题会自动提取知识点，之后陪练官就能基于知识点出应用题了`,
          }
        }

        const { questions, rejected, mode } = await generateInterviewQuestions(context, {
          items: topics.map((t) => ({ topic: t, docTitle: doc.title, docId: doc.id, docPath: doc.filePath })),
          count,
        })

        if (questions.length === 0) {
          return { output: '', error: `未能生成应用题（${[...new Set(rejected)].join('；')}）` }
        }

        const dupCount = questions.filter((q) => q.duplicate).length
        return {
          output: [
            `✅ 已生成 ${questions.length} 道应用题（来自《${doc.title}》）并开启模拟面试：`,
            mode === 'llm' ? '（LLM 深度出题：已过接地校验与盲答验证双闸门）' : '（题卡模式：LLM 不可用，已降级为九式题卡保底）',
            dupCount > 0 ? `ℹ️ 其中 ${dupCount} 题此前已生成过（重复练习可巩固）。` : '',
            '作答后请按"讲清楚了吗"自评 0-5 分，自评直接回流掌握度调度。',
            rejected.length > 0 ? `⚠️ ${rejected.length} 题被质量闸门拒收（不污染题库）。` : ''
          ].filter(Boolean).join('\n'),
          ui: {
            intent: 'start_practice',
            questions: questions.map(({ duplicate, ...q }) => q),
            title: `模拟面试：《${doc.title}》（${questions.length} 题）`
          }
        }
      }
    )

    context.registerAgentTool(
      {
        name: 'start_weak_interview',
        description: '薄弱专项陪练：从错题与低正确率（<60%）题目集中的文档提取主题，生成九式应用题专项演练（start_practice）——从错误处学。用户说「练薄弱点/针对弱项陪练/带我演练错的地方」时使用。',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'number', description: '题数，默认 3，上限 8' }
          }
        }
      },
      async (args) => {
        const count = Math.min(Math.max(Number(args.count) || 3, 1), 8)
        // 薄弱文档（权威源 SQL；getDocuments 为仓库限定面，跨仓库薄弱文档必须走 JOIN）
        let weakDocIds = []
        try {
          const rows = (await context.query(
            // ⚠️ ctx.query 返回行键为驼峰（7.y2 契约）——document_id 必须显式别名
            `SELECT DISTINCT q.document_id AS documentId FROM questions q
             WHERE q.status = 'confirmed' AND (
               SELECT AVG(CASE WHEN a.correct = 1 THEN 100.0 ELSE 0 END)
               FROM question_attempts a WHERE a.question_id = q.id
             ) < 60 LIMIT 8`,
          )) || []
          weakDocIds = rows.map((r) => String(r.documentId)).filter(Boolean)
        } catch { weakDocIds = [] }
        if (!weakDocIds.length) {
          return { output: '近期没有薄弱题目（正确率<60%）。要么掌握得很扎实，要么还没有作答数据——先做一轮题，错的地方我会带你专项演练。' }
        }
        let anchors = []
        try {
          const rows = (await context.query(
            `SELECT id, title, file_path AS docPath FROM documents WHERE id IN (${weakDocIds.map(() => '?').join(',')})`,
            weakDocIds,
          )) || []
          anchors = rows
            .map((r) => {
              const topic = sanitizeTopic(r.title)
              return topic ? { topic, docTitle: String(r.title || ''), docId: String(r.id), docPath: String(r.docPath || '') } : null
            })
            .filter(Boolean)
        } catch { anchors = [] }
        if (!anchors.length) return { output: '', error: '薄弱题目所在的文档已不在知识库中（重新导入或剪藏相关内容后，再来专项演练）' }

        // 专项演练：题数补满（锚轮转），同主题也会换不同题卡式
        const items = Array.from({ length: count }, (_, i) => anchors[i % anchors.length])
        const { questions, rejected, mode } = await generateInterviewQuestions(context, { items, count })
        if (questions.length === 0) {
          return { output: '', error: `未能生成薄弱专项应用题（${[...new Set(rejected)].join('；')}）` }
        }
        const dupCount = questions.filter((q) => q.duplicate).length
        return {
          output: [
            `🎯 薄弱专项陪练（主题：${anchors.map((a) => a.topic).join('、')}）：`,
            `✅ 已生成 ${questions.length} 道应用题并开启演练：`,
            mode === 'llm' ? '（LLM 深度出题：已过接地校验与盲答验证双闸门）' : '（题卡模式：LLM 不可用，已降级为九式题卡保底）',
            dupCount > 0 ? `ℹ️ 其中 ${dupCount} 题此前已生成过（重复练习可巩固）。` : '',
            '作答后请按"讲清楚了吗"自评 0-5 分，自评直接回流掌握度调度。',
          ].filter(Boolean).join('\n'),
          ui: {
            intent: 'start_practice',
            questions: questions.map(({ duplicate, ...q }) => q),
            title: `薄弱专项陪练（${questions.length} 题）`
          }
        }
      }
    )
  },

  deactivate() {}
}


