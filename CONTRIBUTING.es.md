**Otros idiomas:** [English](CONTRIBUTING.md) · [Português](CONTRIBUTING.pt-BR.md) · [हिंदी](CONTRIBUTING.hi.md) · [简体中文](CONTRIBUTING.zh-CN.md)

# Contribuir a env-saaf

¡Gracias por pasarte por aquí! env-saaf es un paquete pequeño y sin dependencias, y las contribuciones de cualquier tamaño son bienvenidas: corregir una errata vale tanto como una funcionalidad nueva.

## Reglas básicas

- **Cero dependencias, para siempre.** La razón de ser de este paquete es que no añade nada a tu `node_modules`. Los PR que añadan una dependencia en tiempo de ejecución se cerrarán (con amabilidad).
- **Node >= 16.** El código debe funcionar en Node 16 y versiones posteriores. JavaScript simple, punto de entrada CommonJS (`index.js`), tipos de TypeScript en `index.d.ts`.
- **Las pruebas deben pasar, y todo comportamiento nuevo necesita una prueba.** Usamos el estilo integrado `node:assert` en `test.js`: no hay ningún framework de pruebas que aprender.

## Primeros pasos

```bash
git clone https://github.com/abhi478jeetur-rgb/env-saaf.git
cd env-saaf
npm test        # runs the full test file, no install step needed
```

## Elegir algo en lo que trabajar

- Los issues con la etiqueta **`good first issue`** son pequeños, autocontenidos y un buen punto de partida.
- Los issues con la etiqueta **`help wanted`** son cosas con las que el mantenedor quiere ayuda activamente.
- Si quieres trabajar en algo más grande, abre primero un issue y coméntalo: así nadie construye dos veces lo mismo.

## Hacer un cambio

1. Haz un fork del repositorio y crea una rama: `git checkout -b fix/short-name`
2. Haz tu cambio en `index.js` (y en `cli.js` / `index.d.ts` si se ven afectados).
3. Añade o actualiza las pruebas en `test.js`.
4. Añade una línea sobre tu cambio bajo `## Unreleased` en `CHANGELOG.md`.
5. Ejecuta `npm test` y asegúrate de que pasa.
6. Abre un Pull Request y completa la plantilla. Enlaza el issue que resuelve (`Fixes #123`).

## Versiones publicadas

De las versiones publicadas se encarga el mantenedor, así que no subas el campo `version` de `package.json` en tu PR: basta con añadir una línea para tu cambio bajo `## Unreleased` en `CHANGELOG.md`.

## Reportar errores y pedir funcionalidades

Usa las plantillas de issues. Un buen reporte de error incluye: lo que esperabas, lo que ocurrió en realidad, un fragmento de código mínimo que lo reproduzca y tu versión de Node (`node -v`).

## Estilo de código

- Sigue el estilo que ya hay en el archivo: `'use strict'`, comillas simples, funciones pequeñas y comentarios que explican el *porqué*, no el *qué*.
- Mantén pequeña la superficie de la API pública. Las exportaciones nuevas necesitan una razón sólida, debatida antes en el issue.

¿Preguntas? Abre un issue: para eso están.
