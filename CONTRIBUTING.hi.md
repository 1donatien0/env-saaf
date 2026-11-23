**अन्य भाषाएँ:** [English](CONTRIBUTING.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [简体中文](CONTRIBUTING.zh-CN.md)

# env-saaf में योगदान

यहाँ आने के लिए धन्यवाद! env-saaf एक छोटा, zero-dependency पैकेज है, और हर आकार के योगदान का स्वागत है — एक typo ठीक करना भी उतना ही मायने रखता है जितना कोई नया feature।

## बुनियादी नियम

- **Zero dependencies, हमेशा।** इस पैकेज का पूरा मकसद ही यही है कि यह आपके `node_modules` में कुछ नहीं जोड़ता। runtime dependency जोड़ने वाले PR बंद कर दिए जाएँगे (प्यार से)।
- **Node >= 16।** कोड Node 16 और उसके बाद के versions पर चलना चाहिए। Plain JavaScript, CommonJS entry (`index.js`), TypeScript types `index.d.ts` में।
- **Tests pass होने चाहिए, और नए behaviour के लिए test ज़रूरी है।** हम `test.js` में built-in `node:assert` style इस्तेमाल करते हैं — सीखने के लिए कोई test framework नहीं है।

## शुरुआत करना

```bash
git clone https://github.com/abhi478jeetur-rgb/env-saaf.git
cd env-saaf
npm test        # runs the full test file, no install step needed
```

## काम चुनना

- **`good first issue`** label वाले issues छोटे, self-contained होते हैं और शुरुआत के लिए बढ़िया जगह हैं।
- **`help wanted`** label वाले issues वे चीज़ें हैं जिनमें maintainer को सच में मदद चाहिए।
- अगर आप कुछ बड़ा करना चाहते हैं, तो पहले एक issue खोलकर बता दें — ताकि कोई एक ही चीज़ दो बार न बना दे।

## बदलाव करना

1. Repo को fork करें और एक branch बनाएँ: `git checkout -b fix/short-name`
2. अपना बदलाव `index.js` में करें (और अगर वे प्रभावित हों तो `cli.js` / `index.d.ts` में भी)।
3. `test.js` में tests जोड़ें या update करें।
4. `CHANGELOG.md` में `## Unreleased` के नीचे अपने बदलाव की एक line जोड़ें।
5. `npm test` चलाएँ और पक्का करें कि वह pass हो।
6. एक Pull Request खोलें और template भरें। जिस issue को यह ठीक करता है, उसे link करें (`Fixes #123`)।

## Releases

Releases maintainer संभालता है, इसलिए कृपया अपने PR में `package.json` का `version` न बढ़ाएँ — बस `CHANGELOG.md` में `## Unreleased` के नीचे अपने बदलाव की एक line जोड़ दें।

## Bug report करना और feature माँगना

Issue templates का इस्तेमाल करें। एक अच्छी bug report में शामिल होता है: आपको क्या उम्मीद थी, असल में क्या हुआ, एक छोटा code snippet जो उसे reproduce करे, और आपका Node version (`node -v`)।

## Code style

- File में पहले से मौजूद style से मेल खाएँ: `'use strict'`, single quotes, छोटे functions, और comments जो *क्यों* बताएँ, *क्या* नहीं।
- Public API surface छोटा रखें। नए exports के लिए पहले issue discussion में एक मज़बूत कारण चाहिए।

सवाल हैं? एक issue खोलिए — issues उसी के लिए हैं।
