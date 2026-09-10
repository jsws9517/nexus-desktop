/**
 * Extract a short topic from user input for auto-session-naming.
 * Supports both Chinese and English input.
 * Examples:
 *   "帮我写一个排序算法" → "排序算法"
 *   "Help me write a sorting algorithm" → "Sorting Algorithm"
 */
export function extractTopic(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';

  // Detect if input contains Chinese characters
  const hasChinese = /[\u4e00-\u9fa5]/.test(trimmed);

  if (hasChinese) {
    return extractChineseTopic(trimmed);
  } else {
    return extractEnglishTopic(trimmed);
  }
}

function extractChineseTopic(input: string): string {
  // Step 1: Remove common prefix verbs/particles
  const cleaned = input
    .replace(/^(帮我|请帮我|我需要|我想要|我要|需要|给|为|把|让|和|与|来|写|做一个|搞一个|弄一个)/g, '')
    .replace(/^(如何|怎么|怎样|怎么样)/g, '')
    .trim();

  // Step 2: Extract core topic - look for the main noun phrase
  const patterns = [
    // "写个傅里叶变换的python实现代码" → "傅里叶变换"
    /(?:写|做|实现|创建|开发|设计|编写|制作|完成|搞|弄)(?:个|一个|一下|简单的)?\s*(.+?)(?:的python|的java|的js|的typescript|的代码|的功能|的算法|的实现|的程序|的模块|的组件|的接口|的方法|的函数|的脚本|的工具|的系统|的应用|的服务)/,
    // "写个傅里叶变换" → "傅里叶变换"
    /(?:写|做|实现|创建|开发|设计|编写|制作|完成|搞|弄)(?:个|一个|一下|简单的)?\s*(.+?)(?:\s*(?:来|去|要|能)?\s*(?:显示|处理|统计|计算|分析|管理|实现|创建|开发))/,
    /(?:写|做|实现|创建|开发|设计|编写|制作|完成|搞|弄)(?:个|一个|一下|简单的)?\s*(.+)/,
    // "傅里叶变换的python实现" → "傅里叶变换"
    /(.+?)(?:的python|的java|的js|的typescript|的实现|的代码|的功能|的算法|的程序|的模块|的组件|的接口|的方法|的函数|的脚本|的工具|的系统|的应用|的服务)/,
    // "如何实现傅里叶变换" → "傅里叶变换"
    /(?:如何|怎么|怎样)(?:实现|做|写|创建|开发)?\s*(.+)/,
    // "用Python读取Excel" → "Python读取Excel" or "读取Excel"
    /(?:用|使用)\s*(\w[\w\s]*(?:读取|处理|分析|计算|统计|显示|管理)\s*\w+)/,
    // Fallback: extract between 2-15 characters
    /(.{2,15})/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      let topic = match[1].trim();
      // Remove leading particles
      topic = topic.replace(/^(的|个|一个|了|着|地|得|简单的)/, '');
      topic = topic.replace(/(的|了|着|地|得)$/, '');
      // Truncate at action verbs
      topic = topic.replace(/\s*(来|去|要|能)?\s*(显示|处理|统计|计算|分析|管理|实现|创建|开发).*$/, '');
      topic = topic.trim();
      if (topic.length >= 2 && topic.length <= 20) {
        return topic;
      }
    }
  }

  // Final fallback
  return cleaned.slice(0, 20) || input.slice(0, 20);
}

function extractEnglishTopic(input: string): string {
  // Remove common prefix verbs
  const cleaned = input
    .replace(/^(help me |please |can you |I want to |I need to |could you )/i, '')
    .replace(/^(write|create|implement|design|build|make|develop|fix|debug|optimize|refactor|test)/i, '')
    .replace(/\s*(a|an|the|for|to|in|of|with|that|which|and|or)\s*/gi, ' ')
    .trim();

  // Extract core noun phrases
  const patterns = [
    /(?:a|an|the)\s+([\w\s]+?)(?:\s+for\s+.+)?$/i,
    /how to\s+([\w\s]+?)(?:\s+in\s+.+)?$/i,
    /([\w\s]+?)(?:\s+function|algorithm|module|component|feature|code|implementation)/i,
    /([\w]+(?:\s+[\w]+){0,2})/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      // Remove stopwords, keep meaningful words
      const meaningful = match[1]
        .replace(/\b(a|an|the|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|must|shall|can|need|dare|ought|used)\b/gi, '')
        .trim();
      if (meaningful.length > 0) {
        return capitalizeFirst(meaningful.slice(0, 40));
      }
    }
  }

  // Fallback: take first 3 meaningful words
  const words = cleaned.split(/\s+/).filter(w => w.length > 2);
  return capitalizeFirst(words.slice(0, 3).join(' '));
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}