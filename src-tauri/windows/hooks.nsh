; Code ajouté à l'installateur Windows (NSIS) fabriqué par Tauri.
; Tauri l'insère grâce à `bundle.windows.nsis.installerHooks` dans
; tauri.conf.json ; chaque macro est appelée à un moment précis.
;
; Les versions de Dofus Team Manager se remplacent déjà entre elles : Tauri
; désinstalle automatiquement la version précédente. Mais jusqu'à la 0.1.0,
; l'application s'appelait « Dofus Organizer » : pour Windows, c'est une autre
; application, qu'il faut retirer nous-mêmes.

; Le nom sous lequel l'ancienne version s'est inscrite dans la liste des
; programmes installés de Windows.
!define OLD_PRODUCT_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dofus Organizer"

; Appelée juste avant de copier les fichiers de la nouvelle version.
!macro NSIS_HOOK_PREINSTALL
  ; L'ancienne version est-elle installée ? On lit sa commande de
  ; désinstallation (SHCTX = la partie du registre propre à l'utilisateur,
  ; comme l'installation).
  ReadRegStr $R9 SHCTX "${OLD_PRODUCT_UNINSTKEY}" "UninstallString"
  ${If} $R9 != ""
    DetailPrint "Désinstallation de l'ancienne version (Dofus Organizer)…"
    ; `/S` : désinstallation silencieuse. Les réglages de l'utilisateur ne
    ; sont pas effacés : la nouvelle version les reprend au premier lancement.
    ExecWait '$R9 /S'
  ${EndIf}
!macroend
