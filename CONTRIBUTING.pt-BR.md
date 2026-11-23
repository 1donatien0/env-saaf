**Outros idiomas:** [English](CONTRIBUTING.md) · [Español](CONTRIBUTING.es.md) · [हिंदी](CONTRIBUTING.hi.md) · [简体中文](CONTRIBUTING.zh-CN.md)

# Contribuindo com o env-saaf

Obrigado pela visita! O env-saaf é um pacote pequeno, sem dependências, e contribuições de todos os tamanhos são bem-vindas — a correção de um erro de digitação conta tanto quanto um recurso novo.

## Regras básicas

- **Zero dependências, para sempre.** A razão de ser deste pacote é que ele não adiciona nada ao seu `node_modules`. PRs que adicionarem uma dependência em tempo de execução serão fechados (educadamente).
- **Node >= 16.** O código precisa funcionar no Node 16 e em versões mais recentes. JavaScript puro, entrada CommonJS (`index.js`), tipos TypeScript em `index.d.ts`.
- **Os testes precisam passar, e comportamento novo precisa de um teste.** Usamos o estilo do `node:assert` integrado em `test.js` — nenhum framework de testes para aprender.

## Primeiros passos

```bash
git clone https://github.com/abhi478jeetur-rgb/env-saaf.git
cd env-saaf
npm test        # runs the full test file, no install step needed
```

## Escolhendo algo para trabalhar

- Issues com o rótulo **`good first issue`** são pequenas, independentes e um ótimo lugar para começar.
- Issues com o rótulo **`help wanted`** são coisas com as quais o mantenedor quer ativamente ajuda.
- Se você quiser trabalhar em algo maior, abra uma issue primeiro e avise — assim ninguém constrói a mesma coisa duas vezes.

## Fazendo uma alteração

1. Faça um fork do repositório e crie uma branch: `git checkout -b fix/short-name`
2. Faça sua alteração em `index.js` (e em `cli.js` / `index.d.ts`, se forem afetados).
3. Adicione ou atualize os testes em `test.js`.
4. Adicione uma linha sobre a sua alteração em `## Unreleased` no `CHANGELOG.md`.
5. Execute `npm test` e certifique-se de que ele passa.
6. Abra um Pull Request e preencha o modelo. Vincule a issue que ele resolve (`Fixes #123`).

## Lançamentos

Os lançamentos são feitos pelo mantenedor, então não altere a `version` no `package.json` no seu PR — apenas adicione uma linha para a sua alteração em `## Unreleased` no `CHANGELOG.md`.

## Relatando bugs e pedindo recursos

Use os modelos de issue. Um bom relato de bug inclui: o que você esperava, o que realmente aconteceu, um pequeno trecho de código que o reproduz e a sua versão do Node (`node -v`).

## Estilo de código

- Siga o estilo que já está no arquivo: `'use strict'`, aspas simples, funções pequenas, comentários que explicam o *porquê*, não o *quê*.
- Mantenha a superfície da API pública pequena. Exportações novas precisam de um motivo forte na discussão da issue primeiro.

Dúvidas? Abra uma issue — é para isso que elas servem.
