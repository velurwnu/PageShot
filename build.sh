#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  PageShot — сборка расширения для Safari (macOS)
#
#  ./build.sh          собрать приложение, поставить в /Applications и запустить
#  ./build.sh xcode    создать Xcode-проект (папка xcode/) и открыть его
#  ./build.sh clean    удалить сгенерированные проекты и сборки
#
#  Переменные окружения:
#    TEAM_ID=ABCDE12345   Team ID для подписи (по умолчанию ищется сам)
#    BUNDLE_ID=...        идентификатор приложения (по умолчанию com.roma.PageShot)
#
#  Нужен полный Xcode из App Store (Command Line Tools не хватит).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="PageShot"
BUNDLE_ID="${BUNDLE_ID:-com.roma.PageShot}"
EXT_DIR="extension"
XCODE_DIR="xcode"     # проект для ручной работы в Xcode (ссылается на extension/)
BUILD_DIR="${BUILD_DIR:-.build}"  # одноразовый проект для сборки из терминала
MODE="${1:-build}"

# Папки, которые синхронизирует iCloud Drive (например, «Документы» и «Рабочий стол»),
# вешают на бандлы (.app, .appex) атрибуты FinderInfo/fileprovider, и codesign падает с
# «resource fork, Finder information, or similar detritus not allowed». Тогда собираем
# в кэше пользователя — он не синхронизируется.
in_file_provider() {
  local d; d="$(pwd -P)"
  while [ "$d" != "/" ]; do
    xattr -p com.apple.file-provider-domain-id "$d" >/dev/null 2>&1 && return 0
    d="$(dirname "$d")"
  done
  return 1
}
if [ "$BUILD_DIR" = ".build" ] && in_file_provider; then
  BUILD_DIR="$HOME/Library/Caches/$APP_NAME-build"
fi

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$MODE" = "clean" ]; then
  rm -rf "$XCODE_DIR" "$BUILD_DIR" .build
  ok "Удалено: $XCODE_DIR/ и $BUILD_DIR/"
  exit 0
fi

# ── проверки ────────────────────────────────────────────────────────────────
[ "$(uname)" = "Darwin" ] || die "Сборка возможна только на macOS."
xcrun --find xcodebuild >/dev/null 2>&1 \
  || die "Не найден xcodebuild. Установи Xcode из App Store и выполни:
    sudo xcode-select -s /Applications/Xcode.app"

TOOL=""
for t in safari-web-extension-packager safari-web-extension-converter; do
  if xcrun --find "$t" >/dev/null 2>&1; then TOOL="$t"; break; fi
done
[ -n "$TOOL" ] || die "Не найден safari-web-extension-packager. Нужен полный Xcode, а не только Command Line Tools:
    sudo xcode-select -s /Applications/Xcode.app"

package() { # $1 — куда, остальные — доп. флаги
  local dest="$1"; shift
  xcrun "$TOOL" "$EXT_DIR" \
    --project-location "$dest" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_ID" \
    --macos-only --swift --no-open --no-prompt --force "$@"
}

# ── иконка приложения ───────────────────────────────────────────────────────
# Xcode 26+ делает иконку в формате .icon; если туда попадает PNG с готовыми
# скруглёнными углами, в Finder выходит маленькая иконка на белой подложке
# (на любой macOS). Подменяем её на свою — art/AppIcon.icon.
XCODE_MAJOR="$(xcodebuild -version 2>/dev/null | sed -nE '1s/^Xcode ([0-9]+).*/\1/p')"
apply_icon() { # $1 — папка, где лежит .xcodeproj
  if [ "${XCODE_MAJOR:-0}" -lt 26 ]; then
    warn "Xcode ${XCODE_MAJOR:-?} не понимает иконки .icon — останется иконка старого формата (нужен Xcode 26+)."
    return 1
  fi
  if ! python3 tools/install-icon.py "$1" "art/AppIcon.icon"; then
    warn "Не удалось подключить новую иконку — останется старая."
    return 1
  fi
}

# ── режим Xcode ─────────────────────────────────────────────────────────────
if [ "$MODE" = "xcode" ]; then
  PROJ="$XCODE_DIR/$APP_NAME/$APP_NAME.xcodeproj"
  if [ ! -d "$PROJ" ]; then
    say "Создаю Xcode-проект через $TOOL…"
    package "$XCODE_DIR"
    apply_icon "$XCODE_DIR/$APP_NAME" || true
  fi
  ok "Проект: $PROJ (файлы расширения берутся из $EXT_DIR/ — правь их там)"
  echo
  echo "Дальше в Xcode:"
  echo "  1. Слева выбери проект $APP_NAME → вкладка Signing & Capabilities."
  echo "  2. Для ОБЕИХ целей ($APP_NAME и $APP_NAME Extension) выбери Team"
  echo "     (бесплатный Apple ID → «Personal Team»)."
  echo "  3. Product → Run (⌘R). Потом включи расширение в Safari → Настройки → Расширения."
  open "$PROJ"
  exit 0
fi

[ "$MODE" = "build" ] || die "Неизвестный режим: $MODE (build | xcode | clean)"

# ── сборка из терминала ─────────────────────────────────────────────────────
PROJ="$BUILD_DIR/project/$APP_NAME/$APP_NAME.xcodeproj"
ICON_APPLIED=0

gen_project() { # $1 = 1 — с новой иконкой
  say "Генерирую проект во временной папке…"
  rm -rf "$BUILD_DIR"
  package "$BUILD_DIR/project" --copy-resources
  [ -d "$PROJ" ] || die "Проект не создался: $PROJ"
  ICON_APPLIED=0
  if [ "$1" = 1 ] && apply_icon "$BUILD_DIR/project/$APP_NAME"; then ICON_APPLIED=1; fi

  SCHEME="$APP_NAME"
  if ! xcodebuild -list -project "$PROJ" 2>/dev/null | grep -qx "        $APP_NAME"; then
    SCHEME="$(xcodebuild -list -project "$PROJ" 2>/dev/null \
      | awk '/Schemes:/{f=1;next} f&&NF{sub(/^ +/,"");print;exit}')"
  fi
}

# Ищем Team ID по сертификату «Apple Development» в связке ключей
TEAM="${TEAM_ID:-}"
if [ -z "$TEAM" ]; then
  CERT="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -m1 'Apple Development' | sed -E 's/.*"(.*)".*/\1/' || true)"
  if [ -n "$CERT" ]; then
    TEAM="$(security find-certificate -c "$CERT" -p 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null \
      | sed -nE 's/.*OU ?= ?([A-Z0-9]{10}).*/\1/p' || true)"
  fi
fi

build() { # $@ — настройки подписи
  xcodebuild -project "$PROJ" -scheme "$SCHEME" -configuration Release \
    -derivedDataPath "$BUILD_DIR/dd" -quiet "$@" build
}

do_build() {
  SIGNED=0
  if [ -n "$TEAM" ]; then
    say "Собираю с подписью разработчика (Team ID $TEAM)…"
    if build -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic; then
      SIGNED=1
      return 0
    fi
    warn "Подписать не вышло (не залогинен Apple ID в Xcode → Settings → Accounts?). Собираю без подписи."
  else
    say "Сертификат разработчика не найден — собираю с локальной подписью…"
  fi
  build CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER=
}

gen_project 1
if ! do_build; then
  [ "$ICON_APPLIED" = 1 ] || die "Сборка не удалась — смотри ошибки выше."
  warn "Сборка с новой иконкой не прошла — пробую со старой."
  gen_project 0
  do_build || die "Сборка не удалась — смотри ошибки выше."
fi

APP="$BUILD_DIR/dd/Build/Products/Release/$APP_NAME.app"
[ -d "$APP" ] || die "Сборка завершилась, но $APP не найден."
ok "Собрано: $APP"

# ── установка ───────────────────────────────────────────────────────────────
# В новых macOS Safari подхватывает расширения только из приложений в /Applications
DEST="/Applications/$APP_NAME.app"
pkill -x "$APP_NAME" 2>/dev/null || true
if rm -rf "$DEST" 2>/dev/null && ditto "$APP" "$DEST" 2>/dev/null; then
  ok "Установлено: $DEST"
else
  warn "Нет прав на /Applications — нужен пароль администратора."
  sudo rm -rf "$DEST"
  sudo ditto "$APP" "$DEST"
  ok "Установлено: $DEST"
fi
# Сбрасываем кэш иконки, чтобы Finder сразу показал новую
touch "$DEST" 2>/dev/null || true
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$DEST" >/dev/null 2>&1 || true
open "$DEST"
[ "$ICON_APPLIED" = 1 ] && ok "Иконка в новом формате (Liquid Glass). Если Finder показывает старую — выполни: killall Finder Dock"

echo
echo "Осталось включить в Safari:"
if [ "$SIGNED" = 0 ]; then
  echo "  0. Safari → Настройки → Дополнения → «Показывать функции для веб-разработчиков»,"
  echo "     затем вкладка «Разработчик» → «Разрешить неподписанные расширения»."
  echo "     (Эта галочка сбрасывается при каждом перезапуске Safari. Чтобы не сбрасывалась —"
  echo "      войди в Xcode → Settings → Accounts своим Apple ID и запусти ./build.sh ещё раз.)"
fi
echo "  1. Safari → Настройки → Расширения → поставь галочку у PageShot."
echo "  2. Там же «Изменить веб-сайты…» → «Другие веб-сайты: Разрешить» — чтобы не спрашивал на каждом сайте."
echo "  3. Кнопка PageShot появится на панели инструментов Safari."
echo
echo "Окно приложения PageShot после этого можно закрыть: оно нужно только для установки,"
echo "расширение работает внутри Safari и держать приложение запущенным не нужно."
