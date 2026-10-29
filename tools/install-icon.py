#!/usr/bin/env python3
"""
Подключает иконку Icon Composer (art/AppIcon.icon) к Xcode-проекту,
который создал safari-web-extension-packager.

Зачем: Xcode 26+ собирает иконку приложения в новом формате (.icon). Если в
качестве иконки ему достаётся PNG с собственными скруглёнными углами и
прозрачными полями (как иконка расширения), получается маленькая картинка
на белой/серой подложке — и на macOS 26, и на более старых системах, для
которых Xcode рендерит запасной вариант из того же .icon. Наша иконка
нарисована «в край», и система сама делает из неё правильную форму.

Что делает:
  а) если упаковщик уже создал в проекте .icon (Xcode 26+ так делает) —
     подменяет его содержимое нашим;
  б) иначе находит AppIcon.appiconset в Assets.xcassets приложения, кладёт
     рядом AppIcon.icon, прописывает его в project.pbxproj (ссылка на файл +
     фаза Resources) и удаляет AppIcon.appiconset, чтобы не было двух иконок
     с одним именем.

Повторный запуск безопасен. При любой неожиданности проект не трогается
(сборка продолжится со старой иконкой), а скрипт возвращает код 2.

Использование: install-icon.py <папка с .xcodeproj> <путь к AppIcon.icon>
"""
import pathlib
import re
import shutil
import sys
import uuid


def fail(msg: str) -> None:
    print(f"install-icon: {msg}", file=sys.stderr)
    sys.exit(2)


def new_id(text: str) -> str:
    while True:
        i = uuid.uuid4().hex[:24].upper()
        if i not in text:
            return i


def main() -> None:
    if len(sys.argv) != 3:
        fail("использование: install-icon.py <папка проекта> <AppIcon.icon>")

    root = pathlib.Path(sys.argv[1])
    icon_src = pathlib.Path(sys.argv[2])
    if not (icon_src / "icon.json").is_file():
        fail(f"нет {icon_src}/icon.json")

    pbx_list = list(root.glob("*.xcodeproj/project.pbxproj"))
    if len(pbx_list) != 1:
        fail(f"ожидался один .xcodeproj в {root}, найдено: {len(pbx_list)}")
    pbx = pbx_list[0]
    text = pbx.read_text(encoding="utf-8")

    # а) .icon уже есть (создан упаковщиком или нами при прошлом запуске) — подменяем
    existing = [p for p in root.rglob("*.icon")
                if p.is_dir() and (p / "icon.json").is_file() and ".xcodeproj" not in p.parts]
    if existing:
        for p in existing:
            shutil.rmtree(p)
            shutil.copytree(icon_src, p)
            print(f"install-icon: заменена иконка {p.relative_to(root)}")
        return

    # б) .icon нет — добавляем рядом с каталогом ассетов приложения
    sets = [p for p in root.rglob("AppIcon.appiconset")
            if ".xcodeproj" not in p.parts and "Extension" not in str(p.relative_to(root))]
    if not sets:
        fail("в проекте нет ни .icon, ни AppIcon.appiconset — не знаю, куда класть иконку")
    icon_dst = sets[0].parent.parent / "AppIcon.icon"

    asset_refs = re.findall(
        r"^\s*([0-9A-F]{24}) /\* Assets\.xcassets \*/ = \{isa = PBXFileReference;[^\n]*$",
        text, flags=re.M)

    if not asset_refs:
        # Новые проекты Xcode используют «синхронизированные» папки:
        # всё, что лежит в папке, попадает в цель само.
        if "PBXFileSystemSynchronizedRootGroup" not in text:
            fail("в project.pbxproj нет ссылки на Assets.xcassets — не знаю, куда добавлять иконку")
    else:
        if len(asset_refs) > 1:
            print("install-icon: найдено несколько Assets.xcassets — беру первый", file=sys.stderr)
        aref = asset_refs[0]

        m_bf = re.search(
            rf"^\s*([0-9A-F]{{24}}) /\* Assets\.xcassets in Resources \*/ = "
            rf"\{{isa = PBXBuildFile; fileRef = {aref} ",
            text, flags=re.M)
        if not m_bf:
            fail("не нашёл Assets.xcassets в фазе Resources")
        abf = m_bf.group(1)

        ref = new_id(text)
        bf = new_id(text + ref)

        def insert_after_line(src: str, pattern: str, new_line: str) -> str:
            m = re.search(pattern, src, flags=re.M)
            if not m:
                fail(f"шаблон не найден: {pattern}")
            end = src.index("\n", m.end()) + 1
            return src[:end] + new_line + "\n" + src[end:]

        def add_to_list(src: str, item_re: str, new_item: str) -> str:
            pat = re.compile(rf"^(\s*){item_re},$", flags=re.M)
            matches = pat.findall(src)
            if len(matches) != 1:
                fail(f"ожидалось одно вхождение «{item_re}», найдено {len(matches)}")
            return pat.sub(lambda m: f"{m.group(0)}\n{m.group(1)}{new_item},", src, count=1)

        text = insert_after_line(
            text,
            rf"^\s*{aref} /\* Assets\.xcassets \*/ = \{{isa = PBXFileReference;",
            f'\t\t{ref} /* AppIcon.icon */ = {{isa = PBXFileReference; '
            f'lastKnownFileType = folder.iconcomposer.icon; path = AppIcon.icon; sourceTree = "<group>"; }};')
        text = insert_after_line(
            text,
            rf"^\s*{abf} /\* Assets\.xcassets in Resources \*/ = \{{isa = PBXBuildFile;",
            f"\t\t{bf} /* AppIcon.icon in Resources */ = {{isa = PBXBuildFile; "
            f"fileRef = {ref} /* AppIcon.icon */; }};")
        text = add_to_list(text, rf"{aref} /\* Assets\.xcassets \*/", f"{ref} /* AppIcon.icon */")
        text = add_to_list(text, rf"{abf} /\* Assets\.xcassets in Resources \*/",
                           f"{bf} /* AppIcon.icon in Resources */")

    # Всё получилось — записываем изменения
    shutil.rmtree(icon_dst, ignore_errors=True)
    shutil.copytree(icon_src, icon_dst)
    shutil.rmtree(sets[0])
    pbx.write_text(text, encoding="utf-8")

    if "ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;" not in text:
        print("install-icon: внимание — в настройках цели App Icon называется не AppIcon", file=sys.stderr)
    print(f"install-icon: подключена {icon_dst.relative_to(root)}")


if __name__ == "__main__":
    main()
