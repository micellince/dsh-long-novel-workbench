/**
 * 默认预设与 11 个 Agent 分工（含注意力设计师与权重）。
 * 新建作品时自动写入，之后可在 UI 里改。
 */

/** 默认写作方案：章数、字数、结构、审稿口径。 */
export function defaultPresets() {
  return [
    {
      id: 'preset-standard',
      name: '标准长篇方案',
      genre: '',
      pov: '第三人称限知',
      tense: '过去时',
      tone: '克制、有画面感',
      plannedChapters: 80,
      chapterWords: 3000,
      totalWords: 240000,
      structure: '三幕 + 起承转合：第一幕 20% 建置与激励事件；第二幕 50% 升级与中点反转；第三幕 30% 崩塌、高潮、余韵',
      styleRules: [
        '每章至少一个小目标、一个阻碍、一个变化',
        '场景用具体动作与物件推进，少用抽象总结',
        '对话承担信息与性格，不用对话解释设定',
        '每章结尾留下一个未解决的问题',
      ],
      taboo: [
        '巧合解决核心矛盾',
        '角色知道不该知道的信息',
        '大段心理独白代替行动',
        '反派自白式交代阴谋',
      ],
      reviewFocus: ['情节因果', '人物动机', '连续性', '节奏', '对话', '文笔'],
      createdAt: null,
      updatedAt: null,
    },
  ]
}

/** 11 个 Agent 的分工。weight 用于派单顺序 / 汇总排序 / 工作单优先级提示（不改变“提案必须作者采纳”）。 */
export function defaultAgents() {
  // [名字, 职责, 输入, 输出, special, weight]
  // weight：总编 9、独立审稿人 8、注意力设计师 10、其余 3
  const rows = [
    ['总编', '拆解目标、派单、汇总审稿、终审', '作者意图 + 全书状态', '任务书、修订单、定稿结论', undefined, 9],
    ['大纲师', '全书/卷/章大纲与节拍，控制主线与支线', '预设方案 + 已写章节 + 冲突', '章节大纲、情节点、章节目标', undefined, 3],
    ['世界观师', '世界规则、地理、组织、时代设定，维护设定一致性', '已有事实账本 + 世界观条目', '设定条目、规则约束、禁忌清单', undefined, 3],
    ['人物师', '人物卡、关系、动机、弧光，检查人物行为是否可信', '人物库 + 章节出场记录', '人物卡、关系变更、弧光节点', undefined, 3],
    ['时间线师', '事件、故事时间、因果链，保证前后顺序成立', '事件库 + 章节时间', '时间线事件、时间锚点、因果说明', undefined, 3],
    ['伏笔师', '设计埋设与回收，跟踪超期伏笔', '伏笔库 + 已写进度', '伏笔条目、回收计划、超期预警', undefined, 3],
    ['连续性审稿', '对照事实账本检查矛盾：年龄、地点、物品、称谓、伤势', '事实账本 + 章节全文', '矛盾清单（定位 + 建议取值）', undefined, 3],
    ['文笔审稿', '文风、视角、句式、对话、节奏、禁用写法', '写作预设 + 章节全文', '逐段修改建议 + 严重度', undefined, 3],
    ['责任编辑', '汇总各审稿意见，排优先级，产出可执行修订单', '全部审稿记录 + 章节', '修订单（按严重度排序）', undefined, 3],
    // 第 10 个角色：标记 special=fresh-read，UI 高亮与派单过滤都靠它
    ['独立审稿人', '零上下文首读：只拿一章正文，不读账本/预设/大纲/人物卡，给综合阅读意见', '单章正文（不带任何其他上下文）', '首读审稿（dimension=首读）+ 综合意见', 'fresh-read', 8],
    // 第 11 个角色：注意力设计师，权重最高，负责每章注意力结构设计并调度素材
    ['注意力设计师', '为每章设计注意力结构并调度伏笔/冲突/高光素材，给目标分', '大纲 + 最近 attention 记录 + 冷读实测分 + 伏笔/冲突/高光账本', 'attention 提案（四拍 + designScore）+ 下一章注意力设计单', 'attention-designer', 10],
  ]
  return rows.map(([name, duty, inputs, outputs, special, weight], index) => ({
    id: `agent-${index + 1}`,
    order: index + 1,
    name,
    duty,
    inputs,
    outputs,
    enabled: true,
    weight: Number(weight) || 3,
    ...(special ? { special } : {}),
  }))
}

/**
 * 按类型校准的读者预期（用于独立审稿人冷读打分 prompt）。
 * P0 内置六套 + 通用兜底，每套 5 条；作者以后可扩展。
 */
export function attentionGenreProfiles() {
  return {
    武侠: ['爽感兑现（打脸/破局要够力）', '门派与师承的悬念', '情义与背叛的张力', '武打画面具体可想象', '江湖规矩与代价'],
    推理: ['谜面能否勾住读者', '线索对读者是否公平', '嫌疑人的动机是否可信', '反转是否有铺垫', '推理链能否回读验证'],
    科幻: ['核心概念是否震撼', '设定是否自洽', '推演逻辑是否成立', '个人与文明尺度的落差', '技术细节是否建立真实感'],
    言情: ['关系张力是否持续', '情绪能否让读者投射', '误会与和解的节奏', '心动瞬间是否具体', '配角是否推动关系'],
    文学: ['语言质感与节奏', '情绪暗流是否涌动', '细节密度是否足够', '余味与留白', '叙述声音是否统一'],
    悬疑: ['信息差是否持续', '压迫感是否累积', '真相饥饿度', '疑点是否可追踪', '章末是否逼人翻页'],
    通用: ['开篇是否快速抛出钩子', '中段是否有承压点', '本章是否有可感知的回报', '章末是否留下未决问题', '读者是否会点下一章'],
  }
}

/** 内置名家风格预设库（可一键加入作品）。 */
export function builtinPresets() {
  const base = { source: 'builtin', language: '中文' }
  return [
    {
      ...base, id: 'style-jinyong', name: '金庸风格 · 武侠',
      authorStyle: '金庸', genre: '武侠', pov: '第三人称全知', tense: '过去时',
      tone: '沉稳、厚重、家国情怀',
      plannedChapters: 40, chapterWords: 8000, totalWords: 320000,
      structure: '章回体：每回一个小高潮，全书以家国大势推进；正邪不两立但人物有灰度',
      description: '以事写人，武打重意境与文化根脉，情感含蓄克制，历史与江湖交织。',
      styleRules: ['武功招式要有出处与文化意象，避免纯数值化', '人物通过选择与行动立住，少直接评判', '历史背景要具体，虚实相生', '情感戏借景、借物、借动作，不直白抒情', '每回结尾留悬念或反转'],
      taboo: ['现代语汇与网络用语', '主角无代价地碾压一切', '大段心理独白代替行动'],
      reviewFocus: ['情节因果', '人物动机', '历史质感', '武学体系', '情感含蓄', '章回收束'],
    },
    {
      ...base, id: 'style-gulong', name: '古龙风格 · 武侠',
      authorStyle: '古龙', genre: '武侠', pov: '第三人称限知', tense: '过去时',
      tone: '冷、快、留白、带一点黑色幽默',
      plannedChapters: 30, chapterWords: 5000, totalWords: 150000,
      structure: '短章快节奏：一个谜面接一个反转，人物登场即立住，结局常有荒诞感',
      description: '短句、留白、机锋对话，重氛围与人性，不重招式拆解。',
      styleRules: ['短句为主，一句一行也可以', '对话要有机锋，能一句话立住人物', '不解释高手为什么强，用结果和旁人反应写', '场景要有电影感：光、声、气味', '善恶暧昧，避免脸谱化'],
      taboo: ['冗长铺陈', '招式说明书式打斗', '说教式总结'],
      reviewFocus: ['节奏', '对话', '氛围', '人物登场', '反转'],
    },
    {
      ...base, id: 'style-liangyusheng', name: '梁羽生风格 · 武侠',
      authorStyle: '梁羽生', genre: '武侠', pov: '第三人称全知', tense: '过去时',
      tone: '典雅、清正、名士风流',
      plannedChapters: 36, chapterWords: 6000, totalWords: 216000,
      structure: '章回体 + 诗词开篇：以史为骨、以情为血，正邪分明而有悲悯',
      description: '文白相融，诗词入章，情感克制，侠义与家国并重。',
      styleRules: ['回目对仗，开篇可用诗词定调', '对话文白相融，称谓合身份', '情感含蓄，借景借物', '史实与虚构分清，关键处不硬伤', '武打写意，点到即止'],
      taboo: ['白话网络腔', '心理独白', '史实硬伤'],
      reviewFocus: ['文体', '章回结构', '诗词', '史实', '情感'],
    },
    {
      ...base, id: 'style-doyle', name: '柯南·道尔风格 · 推理',
      authorStyle: '柯南·道尔', genre: '推理', pov: '第一人称（助手视角）', tense: '过去时',
      tone: '冷静、克制、带一点英式幽默',
      plannedChapters: 24, chapterWords: 4000, totalWords: 96000,
      structure: '案件引入 → 现场观察 → 假设与排除 → 验证 → 解释；线索对读者公平',
      description: '以助手视角记录天才侦探，观察细节→推理→验证，线索公平。',
      styleRules: ['叙述者不是天才，读者与他同步获得线索', '关键推理必须能回溯到已给细节', '现场描写具体到物件与痕迹', '侦探的解释放在最后，不提前泄底', '每案有一个社会或人性动机'],
      taboo: ['凭空出现的线索', '侦探未卜先知', '超自然解释'],
      reviewFocus: ['线索公平', '推理链', '现场细节', '动机', '叙述者视角'],
    },
    {
      ...base, id: 'style-christie', name: '阿加莎·克里斯蒂风格 · 推理',
      authorStyle: '阿加莎·克里斯蒂', genre: '推理', pov: '第三人称限知（多视角）', tense: '过去时',
      tone: '克制、优雅、暗流涌动',
      plannedChapters: 28, chapterWords: 4000, totalWords: 112000,
      structure: '封闭空间/群像嫌疑 → 逐一访谈 → 红鲱鱼 → 第二次死亡 → 集中解谜',
      description: '封闭空间群像，人人有动机，叙述性诡计与公平线索并用，结尾集中反转。',
      styleRules: ['每个嫌疑人都要有独立动机与不在场证明', '线索公开给读者，但用注意力盲区隐藏', '访谈段落承担人物刻画与信息释放', '至少两条红鲱鱼', '解谜放在最后一场，逐条回收'],
      taboo: ['靠巧合破案', '凶手凭空出现', '叙述者撒谎却不给提示'],
      reviewFocus: ['嫌疑人动机', '线索公平', '红鲱鱼', '叙述诡计', '解谜收束'],
    },
    {
      ...base, id: 'style-higashino', name: '东野圭吾风格 · 社会派推理',
      authorStyle: '东野圭吾', genre: '社会派推理', pov: '第三人称限知（双线）', tense: '过去时',
      tone: '冷峻、克制、余味苦涩',
      plannedChapters: 32, chapterWords: 4500, totalWords: 144000,
      structure: '双线并进：案件线与人物线在中后段交汇；动机比手法更重要',
      description: '动机驱动，写人性困境与社会结构，冷峻叙述，结尾留情感余味。',
      styleRules: ['先立人物困境，再让案件成为困境的出口', '双线交替，信息差制造悬念', '不炫技，手法服务于动机', '结尾不解释情绪，用行动与场景收束', '社会议题要具体到制度与人'],
      taboo: ['为反转而反转', '工具人配角', '道德说教'],
      reviewFocus: ['动机', '双线结构', '人物困境', '社会质感', '余味'],
    },
    {
      ...base, id: 'style-liucixin', name: '刘慈欣风格 · 科幻',
      authorStyle: '刘慈欣', genre: '科幻', pov: '第三人称全知', tense: '过去时',
      tone: '冷静、宏大、带着敬畏',
      plannedChapters: 30, chapterWords: 5000, totalWords: 150000,
      structure: '概念驱动：一个核心设定推演到底，个人命运嵌入文明尺度',
      description: '宏大尺度与硬核设定，冷静叙述，文明视角，概念推演。',
      styleRules: ['核心设定要自洽，能经得起推演', '用具体技术细节建立真实感', '个人情感与文明尺度并置', '叙述保持冷静，不煽情', '关键转折用物理/逻辑必然性推动'],
      taboo: ['设定前后矛盾', '用魔法代替科学', '空洞的史诗腔'],
      reviewFocus: ['设定自洽', '推演逻辑', '尺度感', '人物功能', '结尾'],
    },
    {
      ...base, id: 'style-murakami', name: '村上春树风格 · 文学',
      authorStyle: '村上春树', genre: '文学', pov: '第一人称', tense: '过去时',
      tone: '疏离、平静、带一点荒诞',
      plannedChapters: 20, chapterWords: 4000, totalWords: 80000,
      structure: '日常推进 → 超现实裂缝 → 并行线 → 开放收束',
      description: '第一人称、日常中的超现实、疏离感，比喻与音乐食物细节。',
      styleRules: ['第一人称，语气平实但观察精确', '用食物、音乐、天气建立生活质感', '超现实元素直接出现，不做解释', '比喻要新，避免陈词', '结尾开放，不把意义说尽'],
      taboo: ['解释超自然', '鸡汤式感悟', '过度戏剧化'],
      reviewFocus: ['叙述声音', '日常质感', '超现实处理', '比喻', '结尾'],
    },
  ]
}

/**
 * 默认世界模型：每个作品一份单例（world.json），未生成时 getWorld 返回这份默认值。
 * 坐标空间归一化 0–1000；距离以地点连接的 distanceKm 为准，坐标只用于画图与相对方位。
 */
export function defaultWorld() {
  return {
    id: 'world',
    name: '',
    scale: 'region', // city | region | continent | realm
    kind: 'fictional', // historical | fictional | mixed
    era: '',
    mapSize: { w: 1000, h: 1000 },
    travelModel: { walkKmPerDay: 30, horseKmPerDay: 80, boatKmPerDay: 60 },
    generatedBy: 'manual', // ai | manual | import
    locked: false,
    note: '',
    updatedAt: null,
  }
}

/**
 * 生成整本书流水线（pipeline.json 单例）的默认值；未启动时不落盘。
 * 状态：idle | preparing | ready | running | paused | done | aborted | stuck
 */
export function defaultPipeline() {
  return {
    id: 'pipeline',
    status: 'idle',
    runId: '',
    mode: '', // book | chapters
    count: 0,
    sessionId: '',
    targetChapter: 0,
    base: {
      premise: '',
      genre: '',
      style: '',
      era: '',
      locations: '',
      characters: '',
      volumes: 0,
      chaptersPerVolume: 10,
      wordsPerChapter: 3000,
    },
    budget: { maxTokens: 0, maxCostCNY: 0, usedTokens: 0, usedCostCNY: 0, baseline: null },
    stages: [],
    currentStage: null,
    prepared: { blueprint: false, outline: false },
    notes: [],
    createdAt: null,
    updatedAt: null,
  }
}

/**
 * 扩写（expansion.json 单例）的默认值；未启动时不落盘。
 * 目标字数必须由用户填写，这里保持 0（表示未填），不做任何默认。
 * 状态：idle | planning | plan-ready | waiting-outline | structuring | running | paused | done | stuck
 */
export function defaultExpansion() {
  return {
    id: 'expansion',
    status: 'idle',
    mode: '', // book | chapter
    scope: { type: 'book', chapters: [] },
    targetWords: 0,
    planConfirmed: false,
    chapterTargets: [],
    options: { additions: {}, additionLimit: 0, sampleChapters: 0, allowOutlineChanges: false },
    plan: { diagnosis: [], capacity: [], outlineChanges: [], notes: [] },
    outlineChanges: [],
    approvedOutlineChanges: [],
    runId: '',
    sessionId: '',
    budget: { maxTokens: 0, maxCostCNY: 0, usedTokens: 0, usedCostCNY: 0, baseline: null },
    notes: [],
    createdAt: null,
    updatedAt: null,
  }
}
