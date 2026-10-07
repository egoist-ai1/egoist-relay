# Review модальных окон при FullHD/DPR2

Узкая правка root принята для контролируемого Windows-сценария. Обычные панели ограничены `100dvh - 4rem` с `100vh` fallback. Только в `body.is-windows.is-tauri` панель сдвигается вниз на половину высоты заголовка приложения. Прямой content получает `min-height: 0`; GameModal, browser-modal-dialog и premium-main-modal-dialog исключены. Worker изменил только эти новые JSON/MD review.

Авторитетный [JSON snapshot](display-scale-review.json), SHA256: `feb158ef1e7e0cd40124df21f46d22a91776ed1831ae6fd4c61b261a768615eb`.

## Exact root-owned diff

```diff
diff --git a/src/components/ui/Modal.scss b/src/components/ui/Modal.scss
--- a/src/components/ui/Modal.scss
+++ b/src/components/ui/Modal.scss
@@
-    &.open .modal-dialog {
+    &:not(.GameModal) .modal-dialog:not(.browser-modal-dialog):not(.premium-main-modal-dialog) {
+      body.is-windows.is-tauri & {
+        top: calc(var(--relay-shell-caption-height, 2.5rem) / 2);
+      }
+      max-height: calc(100vh - 4rem);
+      max-height: calc(100dvh - 4rem);
+
+      > .modal-content {
+        min-height: 0;
+      }
+    }
+
+    &.open .modal-dialog {
```

Final source SHA256: `ac4686a9770528f9f113e51cbc2a0cdffad878f926490af71e38c0df5083012d`. Исходник до исправления: `ef53ea8c5eb115c5f8d6d50fd106c881fe58ace1704be42a5266dcce4275a4ac`. Actual settled 68/68 receipt использовал `63c9116de63533ce623793dbb69f42549d0a0fe1b0529b439ea6a1bd5bf1aa5a`; после него только `top` перенесён под существующие Windows/Tauri classes. Поэтому 68/68 не приписывается новым ac4 bytes.

<a id="ordinary-cap"></a>
## Ограничение обычных модальных окон

Ограничение высоты панели через 100vh/100dvh − 4rem сохраняет существующие overflow и анимации. При logical 540 / root 16 панель имеет 476px, content 426/424px вместо измеренных 546.8/548.8px. Контролируемая проверка исходника 63c после завершения CSS-анимаций прошла 68/68, ошибок 0. Final ac4 отличается только условием Windows/Tauri для top.

Подтверждение: Принять узкое ограничение и контролируемую source acceptance; не заявлять исправление установленного native DPI.

<a id="special-layouts"></a>
## Исключения специальных окон

Точные классы GameModal, browser-modal-dialog и premium-main-modal-dialog проверены в исходниках и исключаются целиком. Fullscreen, mobile, height, overflow, transition rules и outer dialog не меняются. Современный Gili Modal использует отдельные классы.

Подтверждение: Принять три точных исключения; не распространять результат на функциональные game/premium/payment сценарии.

<a id="cascade-minimum"></a>
## Cascade и минимальная высота

Modal.scss находится в CSS layer ui.modal, а component overrides — unlayered. Общий min-height: 0 не отменяет ChatLanguage min(75vh,32rem)=405px. При cap 476 доступно 424–426px. Вычитание всей caption height дало бы cap 436 и content 384–386px: конфликт 19/21px.

Подтверждение: Сохранить minimum ChatLanguage; не добавлять вычитание caption или широкий !important override.

<a id="scroll-reachability"></a>
## Прокрутка и кнопки действий

В settled DPR2 light EditContact content 426 / scroll 567, scrollTop 141; dark 424/567, scrollTop 143. Done/Cancel после прокрутки: y 474.25–509.44 / light и 473.25–508.44 / dark; enabled и hitWithin=true. Последний язык виден: y 453–509 / light и 452–508 / dark. Отключённые кнопки остаются отключёнными.

Подтверждение: Принять подтверждённую доступность после прокрутки; не обещать первоначальную видимость или выполнение аккаунтного save.

<a id="evidence-scope"></a>
## Границы проверки

Corrected before 64/68 → settled source 63c 68/68. Шесть первых отказов были readiness harness; восемь промежуточных footer assertions касались отключённых controls. Проверка 67/68 снимала header до завершения CSS animation. Tested 63c и final ac4 разделены; worker не вызывал accounts/native/network.

Подтверждение: Сохранить provenance и границы controlled/native проверки; canonical package не менялся worker.

<a id="caption-tradeoff"></a>
## Заголовок приложения и анимация

При cap 476 и offset 20 settled панель имеет границы 52–528, titlebar 40, content 424–426. В opening LanguageLight panel top 36, title 57, close 57.5 с hitWithin=true; settlement 201ms до top 52. Closing +1rem может дать bottom 544: это source calculation, не measured visual regression.

Подтверждение: Принять измеренную доступность settled и opening controls; сохранить отдельные closing/native DPI/short-height ограничения.

<a id="portability"></a>
## Сдвиг только в Windows/Tauri

Final ac4 переносит только top под body.is-windows.is-tauri; эти классы уже устанавливает initial.ts. Portal вне App.multiRoot использует caption fallback 2.5rem. Windows offset остаётся 20px, другие body classes не получают новый сдвиг. Mac/Linux/legacyElectron не исполнялись.

Подтверждение: Принять узкое условие Windows/Tauri; cap/min-height остаются platform neutral, cross-platform live QA не заявляется.

## Проверенная геометрия

| Logical 960×540, root 16 | Светлая тема | Тёмная тема |
|---|---:|---:|
| Settled panel top / bottom | 52 / 528 | 52 / 528 |
| Header top / titlebar bottom | 52 / 40 | 53 / 40 |
| Content height | 426 | 424 |
| EditContact scrollTop после прокрутки | 141 | 143 |
| Done/Cancel y после прокрутки | 474.25–509.44 | 473.25–508.44 |
| Последний язык y после прокрутки | 453–509 | 452–508 |

В открывающемся ChatLanguage light панель sampled top 36, но title 57 и enabled close 57.5 находятся ниже нижнего края caption 40; hitWithin=true. За 201ms анимация завершается на top 52. Existing closing +1rem может вынести fading panel до 544 при viewport 540: это расчёт из source, а не измеренный regression. Очень малые высоты и native DPI остаются отдельными границами проверки.

## Receipts

| Проектный receipt | Результат | Ограничение |
|---|---|---|
| display-scale-audit-ready-before.json | 64/68 | Четыре измеренных DPR2 component/theme failures |
| display-scale-audit-css-proof.json | 68/68 | Generic CSS injection, не final source |
| display-scale-audit-reachability-proof.json | 8/8 | Внутренний scroll, кнопки и последний язык |
| display-scale-audit-shell-centering-proof.json | 60/68 | Восемь disabled-control driver assertions, disposition parent |
| display-scale-audit-source-after.json | 67/68 | Early opening header assertion до завершения CSS-анимации |
| display-scale-audit-settled-source-after.json | 68/68 | Actual compiled 63c; 0 page/console errors; style/App/Titlebar guards stable |

Settled receipt SHA256: `0f291de613bacc55c7d32230ca52a7985fe01de6910a8a792168d3464e4bb657`. CSS-анимации не отключались; время ожидания их завершения составило 7–227ms. Нет реальных аккаунтных/платёжных действий, внешней сети или user foreground. Это source acceptance контролируемых App/body components с MockClient/native mocks; canonical package и installed native QA оцениваются отдельно.

## Source locations

- Modal.scss:142–152: exact ordinary branch; 143–145: Windows offset; 154/158: open/closing transforms; 162: header; 226: content overflow/max92vh; 315: outer dialog.
- Modal.tsx:324–334: root/dialog classnames; 385: direct content; 395: Portal.
- GameModal.tsx:75–76: root GameModal. BrowserModal.tsx:844 и PremiumMainModal.tsx:437: exact dialog classes.
- ChatLanguageModal.module.scss:5: unlayered min75vh/32rem; NewContactModal.tsx:239–258: кнопки внутри content.
- Portal.ts:16: mount в #portals; index.html:70: вне App.multiRoot. App.module.scss:25: caption 2.5rem.
- Titlebar.module.scss:5–14: fixed top0/z9999/height caption; Titlebar.tsx:115: отсутствует на Mac/nonTauri.
- initial.ts:174–175: is-windows; 182–183: is-tauri; 185–186: legacy Electron class compatibility.

## Оставшиеся границы

Native Windows WebView DPI/text-only scale, очень малые viewport, closing visual frames и специальные окна на других платформах не проверены этим worker. Полный резерв caption не применяется из-за конфликта minimum. Аккаунты, сеть, настройки и production release не менялись.

## Обратная связь

Семь neutral reviewObjects из exact snapshot предназначены parent companion board: ✓ Да / подтверждаю, ✕ Нет, ? Поясни, комментарий на объект, общий комментарий и Применить. Default unreviewed; ответы сохраняются отдельно. Применение принимает указанную рекомендацию или evidence; не запускает install/account/payment/native actions.
