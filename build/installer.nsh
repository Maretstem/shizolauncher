; Удаление лаунчера убирает и его автозапуск с Windows. При обновлении (старая версия удаляется
; перед установкой новой) запись не трогаем — иначе автозапуск выключался бы после каждого обновления.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ShizoLauncher"
  ${endIf}
!macroend
