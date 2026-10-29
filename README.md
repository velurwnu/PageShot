<div align="center">

<img src="extension/icons/icon-128.png" width="128" alt="PageShot Icon">

# PageShot

**English** | [Русский](#pageshot-ru)

</div>

---

## PageShot

A Safari extension for macOS: capture the **entire webpage**, **visible viewport**, or a **selected element** in a single click. The page auto-scrolls, and frames are stitched seamlessly into a clean PNG, WebP, or JPEG. Completely private: zero servers, zero telemetry, everything happens locally in your browser.

---

### Features

- **Full Page, Visible Area, or DOM Element:** Capture full scrolling pages, the visible window, or pick an individual element (long tables, posts, chat containers).
- **Smart Sticky & Fixed Handling:** Headers with `position: sticky` are not duplicated on every frame; floating action buttons, modals, and chat bubbles appear only once (or can be hidden entirely).
- **Lazy Loading Pre-fetch:** Pre-scrolls to trigger lazy images before recording frames.
- **Inner Scrollable Containers:** Seamlessly handles web apps where an inner container scrolls instead of the main window (e.g. webmail, chat messengers).
- **Retina & 1× Scaling:** Crystal-clear Retina (2×) or standard 1×. Ultra-long pages automatically split into manageable segments to prevent browser canvas memory limits.
- **Export to PNG, WebP & JPEG:** Includes a live quality slider with instant file-size calculation before downloading; one-click copy to clipboard.
- **Escape to Cancel:** Press `Esc` anytime to abort capture and restore the page's original scroll position and styles.

---

### Quick Test without Xcode

In modern Safari, you can load the extension folder temporarily:

1. Safari → Settings → Advanced → check **"Show features for web developers"**.
2. Developer menu → **"Add Temporary Extension…"** → select the `extension` folder.
3. Safari → Settings → Extensions → enable **PageShot**.

*(Temporary extensions are unloaded after 24 hours or on browser restart. For permanent installation, build below).*

---

### Build and Installation

Requires **Xcode** from the Mac App Store:

```bash
cd PageShot
./build.sh
```

The script:
1. Generates an Xcode project using `xcrun safari-web-extension-packager`.
2. Compiles the container app `PageShot.app` with the extension bundle inside.
3. Links the modern vector icon in Icon Composer format (`art/AppIcon.icon`) for macOS Liquid Glass support.
4. Moves the app to `/Applications` and registers the extension in Safari.

**Code Signing:**
If your keychain contains an "Apple Development" certificate (available with any free Apple ID via Xcode → Settings → Accounts), the script signs the app automatically. Safari will keep the extension permanently enabled. Without a developer certificate, the build is ad-hoc signed, requiring Developer → "Allow Unsigned Extensions" in Safari (which resets when Safari closes). You can specify your Team ID manually:
```bash
TEAM_ID=ABCDE12345 ./build.sh
```

After building:
1. Safari → Settings → Extensions → check **PageShot**.
2. Click **"Website Settings…"** → set "Other Websites: Allow" to prevent permission prompts on every domain.

### Working with Xcode

```bash
./build.sh xcode
```
Creates a project in `xcode/` linked to `extension/`. You can edit HTML/JS/CSS directly and press **⌘B** in Xcode.

---

### How to Use

Click the PageShot button in the Safari toolbar → choose **"Entire Page"**, **"Visible Area"**, or **"Select Element"**. The button displays live percentage progress during capture. The stitched result opens in a preview tab with format and scale controls.

- **Element Capture:** Hover over any page element to highlight it, showing tag name and dimensions. Click (or press `Enter`) to capture, press `↑` to expand to parent element, `↓` to narrow back down, `Esc` to cancel. Floating headers over the element are automatically hidden.
- **Formats:** PNG (lossless), WebP, and JPEG (quality 80–85 produces 3–10× smaller files). Safari doesn't support native WebP encoding on canvas, so PageShot includes a high-performance WebAssembly build of `libwebp` with SIMD acceleration (`vendor/webp`) running in a Web Worker.
- **Shortcuts:** `⌥⇧S` (Entire Page), `⌥⇧V` (Visible Area), `⌥⇧E` (Element).

---

### Architecture & Resource Footprint

```
extension/
├── manifest.json   Manifest V3
├── background.js   Coordinates capture, takes screenshots (tabs.captureVisibleTab), saves to IndexedDB
├── agent.js        Injected on-demand: inspects DOM, scrolls page, coordinates frame captures
├── popup.*         Toolbar dropdown menu
├── result.*        Canvas frame stitching, export controls, and clipboard copy
├── webp-worker.js  Web Worker for parallel WebP encoding
├── vendor/webp/    libwebp compiled to WebAssembly (Apache-2.0 / BSD)
└── icons/
art/
├── AppIcon.icon    Liquid Glass vector icon for macOS 26+
└── *.svg           Vector source icons
tools/install-icon.py  Connects AppIcon.icon to generated Xcode project
build.sh            Automated build script
```

**Zero Idle Footprint:**
- No scripts are injected before clicking capture (no permanent `content_scripts`).
- Background worker is event-driven and unloads automatically during idle.
- Captured frames are stored in `IndexedDB` during the session and purged immediately when the preview tab is closed.

---

<br>

<a name="pageshot-ru"></a>

<div align="center">

[English](#pageshot) | **Русский**

</div>

---

## PageShot [RU]

Расширение для Safari: скриншот **всей страницы**, **видимой области** или **выбранного элемента** в один клик.
Страница прокручивается сама, кадры склеиваются в один PNG, WebP или JPEG. Без серверов, без аналитики:
всё происходит локально в браузере.

- съёмка всей страницы, видимой области или одного элемента (длинной таблицы, поста, ленты чата);
- шапки с `position: sticky` не повторяются на каждом кадре, плавающие кнопки и чаты видны один раз
  (или убираются совсем галочкой в меню);
- ленивые картинки прогружаются заранее;
- работает и с веб-приложениями, где прокручивается не окно, а блок внутри страницы (почта, мессенджеры);
- Retina-качество или ×1; очень длинные страницы автоматически режутся на части;
- сохранение в PNG, WebP или JPEG с ползунком качества — размер файла виден до сохранения;
  копирование в буфер обмена;
- `Esc` отменяет съёмку, страница возвращается в исходное состояние.

## Быстрая проверка без Xcode

В свежих версиях Safari можно подключить папку расширения напрямую:

1. Safari → Настройки → Дополнения → включи «Показывать функции для веб-разработчиков».
2. Вкладка «Разработчик» → «Добавить временное расширение…» → выбери папку `extension`.
3. Safari → Настройки → Расширения → включи PageShot.

Временное расширение удаляется через 24 часа или при выходе из Safari. Для постоянной установки собери его ниже.

## Сборка и установка

Нужен **Xcode** из App Store (одних Command Line Tools не хватит).

```bash
cd PageShot
./build.sh
```

Скрипт:

1. создаёт Xcode-проект через `xcrun safari-web-extension-packager` (раньше назывался `safari-web-extension-converter`);
2. собирает приложение-контейнер `PageShot.app` с расширением внутри;
3. подключает иконку в формате Icon Composer (`art/AppIcon.icon`), если Xcode 26 или новее;
4. кладёт приложение в `/Applications` (новые macOS подхватывают расширения только оттуда) и запускает один раз.

**Иконка.** Xcode 26 и новее собирает иконку приложения в новом формате `.icon`. Если в него
попадает картинка с готовыми скруглёнными углами и прозрачными полями (как иконка расширения),
в Finder получается маленькая иконка на белой подложке, причём не только на macOS 26, но и на
старых системах: для них Xcode рендерит запасной вариант из того же `.icon`. Поэтому скрипт
подменяет иконку на свою, `art/AppIcon.icon`: она нарисована «в край», форму и эффекты система
добавляет сама. Иконку можно открыть и поправить в Icon Composer (входит в Xcode). Если после
переустановки Finder показывает старую иконку — `killall Finder Dock`.

**Подпись.** Если в связке ключей есть сертификат «Apple Development» (появляется, когда войдёшь своим
Apple ID в Xcode → Settings → Accounts — подойдёт и бесплатный аккаунт), скрипт подпишет им
приложение. Тогда Safari видит расширение всегда. Без сертификата сборка подписывается локально,
и в Safari нужно включать «Разработчик → Разрешить неподписанные расширения» —
**эта галочка сбрасывается при каждом перезапуске Safari**. Team ID можно задать вручную:
`TEAM_ID=ABCDE12345 ./build.sh`.

После установки:

1. Safari → Настройки → Расширения → включи **PageShot**.
2. Там же «Изменить веб-сайты…» → «Другие веб-сайты: Разрешить», иначе Safari будет спрашивать доступ на каждом сайте.

### Работа в Xcode

```bash
./build.sh xcode
```

Создаст проект в `xcode/` и откроет его. Проект ссылается на файлы из `extension/`, так что правишь
JS/HTML/CSS там, а потом в Xcode жмёшь **Product → Build** (⌘B) — Safari подхватит изменения.
Перед первым запуском: проект → Signing & Capabilities → для обеих целей (`PageShot` и
`PageShot Extension`) выбери Team.

Отладка: Safari → Разработка → «Фоновое содержимое веб-расширения» → PageShot — консоль фонового скрипта.
Консоль агента — в обычном веб-инспекторе страницы.

`./build.sh clean` удаляет все сгенерированные проекты и сборки.

## Использование

Кнопка PageShot на панели Safari → «Вся страница», «Видимая область» или «Выбрать элемент». Во время съёмки на кнопке
виден прогресс в процентах. Готовый снимок открывается в новой вкладке: там выбираешь масштаб и формат и сохраняешь.

**Элемент.** После «Выбрать элемент» элемент под курсором подсвечивается, рядом видны его имя и размер.
Щелчок (или `Enter`) — снять его, `↑` — взять родителя (шире), `↓` — вернуться обратно (уже), `Esc` — отмена.
Клики по странице в это время никуда не ведут. Элемент снимается целиком, даже если он длиннее экрана;
если он сам прокручивается (лента чата, блок с прокруткой), снимается всё его содержимое.
Плавающие шапки и кнопки поверх элемента прячутся.

**Формат.** PNG — без потерь, но большие Retina-снимки весят десятки мегабайт. WebP и JPEG с качеством
80–85 обычно в 3–10 раз легче. Пока выбираешь формат и качество, снимок перекодируется в фоне, и в шапке
виден итоговый размер. Выбор запоминается. WebP не бывает больше 16 383 px по стороне, поэтому очень
длинные страницы в WebP режутся на части. Safari не умеет кодировать WebP сам, поэтому в расширении
есть кодировщик libwebp, собранный в WebAssembly (`vendor/webp`); он работает в отдельном потоке.

Горячие клавиши (если Safari их подхватил): `⌥⇧S` — вся страница, `⌥⇧V` — видимая область, `⌥⇧E` — элемент.

Во время съёмки **не переключай вкладку** — Safari умеет снимать только активную.

## Расход ресурсов

Пока ты ничего не снимаешь, расширение ничего не делает:

- в страницы ничего не внедряется заранее (в манифесте нет `content_scripts`) — агент попадает
  на страницу только после нажатия «Вся страница» и после съёмки не оставляет ни таймеров, ни обработчиков;
- фоновый скрипт ничего не опрашивает и не ходит в сеть, у него два обработчика: сообщения от самого
  расширения и горячие клавиши. Safari будит его только по ним и выгружает после простоя;
- приложение PageShot нужно только для установки — его окно можно закрыть, расширение работает без него;
- кадры лежат в хранилище расширения, пока открыта вкладка со снимком, и удаляются при её закрытии.

Проверить можно в Мониторе активности, на вкладке «Энергия».

## Как это устроено

```
extension/
├── manifest.json   Manifest V3
├── background.js   принимает команды, снимает кадры (tabs.captureVisibleTab), хранит их в IndexedDB
├── agent.js        внедряется в страницу: ищет прокручиваемую область, готовит страницу,
│                   прокручивает её и просит фон сделать кадр на каждом шаге
├── popup.*         меню на панели инструментов
├── result.*        склейка кадров на canvas, сохранение (PNG/WebP/JPEG) и копирование
├── webp-worker.js  кодирование WebP в отдельном потоке
├── vendor/webp/    libwebp в WebAssembly (из @jsquash/webp 1.5.0, Apache-2.0 / BSD)
└── icons/
art/
├── AppIcon.icon    иконка приложения для Icon Composer (macOS 26+)
└── *.svg           исходники иконок расширения
tools/install-icon.py  подключает AppIcon.icon к сгенерированному Xcode-проекту
build.sh            сборка под Safari
```

Шаги съёмки всей страницы:

1. Агент выбирает, что прокручивать: окно или самый большой прокручиваемый блок, целиком видимый на экране.
2. Прячет полосы прокрутки, выключает плавную прокрутку, при необходимости пролистывает страницу
   до конца, чтобы прогрузились ленивые картинки.
3. Переводит `sticky`-элементы в `static` (раскладка не меняется, повторов нет) и собирает список `fixed`-элементов.
4. Шагает на высоту экрана; после каждой прокрутки ждёт отрисовки и шлёт фону сообщение `frame`.
   Фон делает `captureVisibleTab` и пишет кадр в IndexedDB. Начиная со второго кадра `fixed`-элементы прячутся.
5. Возвращает странице исходные стили и прокрутку и отдаёт геометрию: размер окна, рамку области,
   фактические позиции прокрутки каждого кадра.
6. Страница результата рисует каждый кадр в точке `(x·s, y·s)`, где `s` — масштаб (на Retina = 2).
   Используются фактические позиции, поэтому последний кадр, который перекрывается с предыдущим,
   встаёт без шва.

Кадры хранятся в IndexedDB, а не в памяти фонового скрипта: Safari может выгрузить service worker
между кадрами, и съёмка от этого не ломается. Кадры удаляются, когда закрываешь вкладку со снимком.

## Ограничения

- Служебные страницы Safari (стартовая, настройки, App Store, страницы других расширений) снимать нельзя.
- Бесконечные ленты обрезаются на 120 экранах.
- Изображение больше ~100 млн пикселей делится на части (ограничение размера canvas).
  Переключение на ×1 уменьшает площадь в 4 раза — часто этого хватает, чтобы получился один файл.
- Анимации, видео и элементы, которые меняются при прокрутке (параллакс), могут выглядеть иначе, чем на экране.
- Между кадрами выдерживается ~0,55 с — это ограничение `captureVisibleTab`, поэтому длинная страница снимается
  несколько секунд.

## Лицензия

MIT — см. [LICENSE](LICENSE).
