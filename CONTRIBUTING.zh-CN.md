**其他语言：** [English](CONTRIBUTING.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [हिंदी](CONTRIBUTING.hi.md)

# 为 env-saaf 做贡献

感谢你的到访！env-saaf 是一个小巧的零依赖包，各种规模的贡献都受欢迎——改一个错别字和添加一个新功能同样重要。

## 基本规则

- **永远零依赖。** 这个包的全部意义就在于它不会给你的 `node_modules` 增加任何东西。添加运行时依赖的 PR 会被关闭（会客气地关）。
- **Node >= 16。** 代码必须能在 Node 16 及更高版本上运行。使用普通 JavaScript，CommonJS 入口（`index.js`），TypeScript 类型放在 `index.d.ts` 中。
- **测试必须通过，新行为需要有测试。** 我们在 `test.js` 中使用内置的 `node:assert` 风格——不需要学习任何测试框架。

## 快速上手

```bash
git clone https://github.com/abhi478jeetur-rgb/env-saaf.git
cd env-saaf
npm test        # runs the full test file, no install step needed
```

## 挑选要做的事

- 标有 **`good first issue`** 的 issue 小而独立，是很好的起点。
- 标有 **`help wanted`** 的 issue 是维护者明确希望有人帮忙的事情。
- 如果你想做更大的改动，请先开一个 issue 说明一下——这样就不会有两个人同时做同一件事。

## 提交改动

1. Fork 仓库并创建分支：`git checkout -b fix/short-name`
2. 在 `index.js` 中进行改动（如果 `cli.js` / `index.d.ts` 也受影响，一并改动）。
3. 在 `test.js` 中添加或更新测试。
4. 在 `CHANGELOG.md` 的 `## Unreleased` 下添加一行，说明你的改动。
5. 运行 `npm test` 并确保通过。
6. 提交 Pull Request 并填写模板。关联它所修复的 issue（`Fixes #123`）。

## 发布

发布由维护者负责，所以请不要在 PR 中修改 `package.json` 里的 `version`——只需在 `CHANGELOG.md` 的 `## Unreleased` 下为你的改动添加一行。

## 报告 bug 和提出功能需求

请使用 issue 模板。一份好的 bug 报告应包括：你期望的结果、实际发生的情况、一个能复现问题的小代码片段，以及你的 Node 版本（`node -v`）。

## 代码风格

- 与文件中已有的风格保持一致：`'use strict'`、单引号、小函数，注释解释*为什么*，而不是*是什么*。
- 保持公共 API 的表面积小。新增导出需要先在 issue 讨论中有充分的理由。

有问题？开一个 issue 吧——issue 就是干这个用的。
