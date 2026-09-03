throw new Error('broken version for rollback test')
'use strict'

/**
 * interviewer 应用阶段插件
 * 内化是"记住"，应用是"会用"。本插件把文档标题/知识点转成开放式应用问题：
 *   "假设你要向新同事解释「X」，你会怎么讲？"
 * 以 short_answer 入题库（生成效应：输出比输入记得牢），做题时用户自评 0-5，
 * 自评直接回流 SM-2 调度与掌握度。
 */

const fsp = require('fs/promises')

const PLUGIN_ID = 'interviewer'

const QUESTION_TEMPLATES = [
  (topic, doc) => `假设你要向完全没有背景的新同事解释「${topic}」（出自《${doc}》），你会怎么讲？请用自己的话写出要点。`,
  (topic, doc) => `请举一个「${topic}」（出自《${doc}》）在实际工作中的应用场景，并说明它解决了什么问题。`,
  (topic, doc) => `如果有人质疑「${topic}」（出自《${doc}》）的价值，你会如何用两三句话论证？`
]

module.exports = {
  id: PLUGIN_ID,
  name: '应用陪练官',
  version: '0.1.0',
  description: '应用阶段：把知识点转成开放式应用问题，强迫输出式复习',

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
        const docs = context.getDocuments() || []
        if (!docs.length) return { output: '', error: '知识库为空' }

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
        topics = [...new Set(topics.filter((t) => t && t.length >= 2 && t.length <= 40))]
        if (topics.length === 0) return { output: '', error: `《${doc.title}》没有可用的标题/知识点，无法生成应用题` }

        const questions = []
        const rejected = []
        for (let i = 0; i < Math.min(count, topics.length); i++) {
          const topic = topics[i % topics.length]
          const tpl = QUESTION_TEMPLATES[i % QUESTION_TEMPLATES.length]
          const question = tpl(topic, doc.title)
          const result = await context.insertQuestion({
            documentId: doc.id,
            type: 'short_answer',
            question,
            answer: `参考方向：结合《${doc.title}》中关于「${topic}」的原文要点作答；自评标准——能讲清"是什么/为什么/怎么用"给 4-5 分。`,
            explanation: '应用题考察输出能力：讲得清楚才算掌握。',
            sourceSnippet: `主题「${topic}」出自《${doc.title}》`,
            pluginId: PLUGIN_ID
          })
          if (result.created || result.duplicate) {
            questions.push({
              id: result.id, documentId: doc.id, documentPath: doc.filePath,
              knowledgePointTitle: topic,
              type: 'short_answer', question,
              answer: `参考方向：结合《${doc.title}》中「${topic}」的原文要点作答。`,
              explanation: '应用题考察输出能力：讲得清楚才算掌握。',
              sourceSnippet: `主题「${topic}」出自《${doc.title}》`, pluginId: PLUGIN_ID,
              duplicate: result.duplicate
            })
          } else {
            rejected.push(result.reason || '入库被拒')
          }
        }

        if (questions.length === 0) {
          return { output: '', error: `未能生成应用题（${[...new Set(rejected)].join('；')}）` }
        }

        return {
          output: [
            `✅ 已生成 ${questions.length} 道应用题（来自《${doc.title}》）并开启模拟面试：`,
            '作答后请按"讲清楚了吗"自评 0-5 分，自评直接回流掌握度调度。',
            rejected.length > 0 ? `⚠️ ${rejected.length} 题被契约拒绝。` : ''
          ].filter(Boolean).join('\n'),
          ui: {
            intent: 'start_practice',
            questions: questions.map(({ duplicate, ...q }) => q),
            title: `模拟面试：《${doc.title}》（${questions.length} 题）`
          }
        }
      }
    )
  },

  deactivate() {}
}


// eco-verify: v0.2.1 iteration
