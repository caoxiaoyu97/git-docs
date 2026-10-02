// MCP（Model Context Protocol）工具定义与调用分发。
// 采用当前规范的单次 POST、无会话握手形态；同时兼容旧客户端的 initialize 握手。
export const PROTOCOL_VERSION = '2026-07-28';

export const TOOLS = [
  {
    name: 'list_repos',
    description: '列出所有文档仓库，以及各自默认分支、已缓存分支和文档数量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_branches',
    description: '列出某个仓库已经缓存、可以阅读的分支。',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: '仓库 ID 或名称' } },
      required: ['repo'],
      additionalProperties: false
    }
  },
  {
    name: 'list_docs',
    description: '列出某个仓库（可选分支）下全部 Markdown 文档的路径和标题。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库 ID 或名称' },
        branch: { type: 'string', description: '分支名，省略则使用默认分支' }
      },
      required: ['repo'],
      additionalProperties: false
    }
  },
  {
    name: 'search_docs',
    description: '在某个仓库的文档中按关键词搜索，返回命中的路径、标题和正文片段。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库 ID 或名称' },
        query: { type: 'string', description: '搜索关键词' },
        branch: { type: 'string', description: '分支名，省略则使用默认分支' },
        limit: { type: 'number', description: '最多返回条数，默认 50，上限 200' }
      },
      required: ['repo', 'query'],
      additionalProperties: false
    }
  },
  {
    name: 'get_doc',
    description: '按路径读取单篇文档的原始 Markdown 内容。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库 ID 或名称' },
        path: { type: 'string', description: '文档在仓库中的相对路径，例如 docs/architecture.md' },
        branch: { type: 'string', description: '分支名，省略则使用默认分支' }
      },
      required: ['repo', 'path'],
      additionalProperties: false
    }
  }
];

export async function callTool(name, args, dataset) {
  if (name === 'list_repos') return dataset.listRepos();
  if (name === 'list_branches') return dataset.listBranches(args.repo);
  if (name === 'list_docs') return dataset.listDocs(args.repo, args.branch);
  if (name === 'search_docs') return dataset.searchDocs(args.repo, args.query, args.branch, args.limit);
  if (name === 'get_doc') return dataset.getDoc(args.repo, args.path, args.branch);
  throw new Error('未知工具：' + name);
}
