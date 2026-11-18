/**
 * Tiny i18n for GitSync. Strings are keyed; each key has an `en` and `ru`
 * value. The active language is chosen from the plugin's "Language" setting,
 * which defaults to following the system language.
 */

export type Lang = "en" | "ru" | "zh";
export type LangPref = "auto" | Lang;

const STRINGS: Record<string, Record<Lang, string>> = {
	// --- ribbon / commands ---
	ribbonSync: { en: "Git Vault Sync: Sync vault", ru: "Git Vault Sync: синхронизировать хранилище", zh: "Git Vault Sync：同步库" },
	ribbonReview: {
		en: "Git Vault Sync: Review changes & sync",
		ru: "Git Vault Sync: просмотреть изменения и синхронизировать",
		zh: "Git Vault Sync：查看更改并同步",
	},
	cmdSync: { en: "Sync vault with Git", ru: "Синхронизировать хранилище с Git", zh: "将库与 Git 同步" },
	cmdReview: {
		en: "Review changes & sync",
		ru: "Просмотреть изменения и синхронизировать",
		zh: "查看更改并同步",
	},
	cmdTest: { en: "Test connection to remote", ru: "Проверить соединение с сервером", zh: "测试与远程的连接" },

	// --- Git Data API engine ---
	apiPullBadUrl: {
		en: "Git Vault Sync: can't parse a GitHub owner/repo from the remote URL.",
		ru: "Git Vault Sync: не удалось разобрать owner/repo GitHub из URL репозитория.",
		zh: "Git Vault Sync：无法从远程地址解析 GitHub 所有者/仓库名。",
	},

	// --- status-bar menu ---
	menuSyncNow: { en: "Sync now", ru: "Синхронизировать сейчас", zh: "立即同步" },
	menuTest: { en: "Test connection", ru: "Проверить соединение", zh: "测试连接" },
	menuSettings: { en: "Open settings", ru: "Открыть настройки", zh: "打开设置" },
	menuShowError: { en: "Show last error", ru: "Показать последнюю ошибку", zh: "显示上次错误" },

	// --- last-error viewer ---
	cmdShowError: {
		en: "Show last sync error",
		ru: "Показать последнюю ошибку синхронизации",
		zh: "显示上次同步错误",
	},
	errModalTitle: { en: "Last sync error", ru: "Последняя ошибка синхронизации", zh: "上次同步错误" },
	errModalWhen: { en: "Occurred: {when}", ru: "Произошла: {when}", zh: "发生时间：{when}" },
	errModalDetail: { en: "Details", ru: "Подробности", zh: "详情" },
	errModalCopy: { en: "Copy details", ru: "Скопировать детали", zh: "复制详情" },
	errModalCopied: { en: "Error details copied", ru: "Детали ошибки скопированы", zh: "错误详情已复制" },
	errModalClose: { en: "Close", ru: "Закрыть", zh: "关闭" },
	errModalNone: {
		en: "No sync error has been recorded.",
		ru: "Ошибок синхронизации не зафиксировано.",
		zh: "尚未记录任何同步错误。",
	},
	errModalHint: {
		en: "The full stack is also in the developer console (Ctrl/Cmd+Shift+I).",
		ru: "Полная трассировка также в консоли разработчика (Ctrl/Cmd+Shift+I).",
		zh: "完整堆栈信息也可在开发者控制台查看（Ctrl/Cmd+Shift+I）。",
	},

	// --- status bar ---
	statusSyncing: { en: "syncing…", ru: "синхронизация…", zh: "同步中…" },
	statusError: { en: "error", ru: "ошибка", zh: "错误" },
	statusConflict: { en: "conflict", ru: "конфликт", zh: "冲突" },
	tipSyncing: { en: "Git Vault Sync: syncing…", ru: "Git Vault Sync: синхронизация…", zh: "Git Vault Sync：同步中…" },
	tipError: {
		en: "Git Vault Sync: last sync failed — click to retry",
		ru: "Git Vault Sync: последняя синхронизация не удалась — нажмите, чтобы повторить",
		zh: "Git Vault Sync：上次同步失败 — 点击重试",
	},
	tipConflict: {
		en: "Git Vault Sync: merge conflict — tap to resolve",
		ru: "Git Vault Sync: конфликт слияния — нажмите, чтобы разрешить",
		zh: "Git Vault Sync：合并冲突 — 点击解决",
	},
	menuResolve: { en: "Resolve conflict", ru: "Разрешить конфликт", zh: "解决冲突" },
	tipChanges: {
		en: "Git Vault Sync: {n} change(s) to sync · last sync {last} · click for options",
		ru: "Git Vault Sync: изменений к синхронизации: {n} · последняя {last} · нажмите для меню",
		zh: "Git Vault Sync：{n} 个更改待同步 · 上次同步 {last} · 点击查看选项",
	},
	tipClean: {
		en: "Git Vault Sync: up to date · last sync {last} · click for options",
		ru: "Git Vault Sync: актуально · последняя синхронизация {last} · нажмите для меню",
		zh: "Git Vault Sync：已是最新 · 上次同步 {last} · 点击查看选项",
	},
	lastNever: { en: "never", ru: "никогда", zh: "从未" },
	lastJustNow: { en: "just now", ru: "только что", zh: "刚刚" },
	lastMin: { en: "{n} min ago", ru: "{n} мин назад", zh: "{n} 分钟前" },
	lastHour: { en: "{n} h ago", ru: "{n} ч назад", zh: "{n} 小时前" },
	lastDay: { en: "{n} d ago", ru: "{n} дн назад", zh: "{n} 天前" },

	// --- sync notices ---
	noticeInProgress: {
		en: "Git Vault Sync: sync already in progress",
		ru: "Git Vault Sync: синхронизация уже идёт",
		zh: "Git Vault Sync：同步正在进行中",
	},
	noticeConfigure: {
		en: "Git Vault Sync: configure remote URL and token in settings first",
		ru: "Git Vault Sync: сначала укажите URL репозитория и токен в настройках",
		zh: "Git Vault Sync：请先在设置中配置远程地址和令牌",
	},
	noticeResult: { en: "Git Vault Sync: {parts}", ru: "Git Vault Sync: {parts}", zh: "Git Vault Sync：{parts}" },
	resultUpToDate: { en: "already up to date", ru: "уже актуально", zh: "已是最新" },
	resultCommitted: { en: "committed", ru: "закоммичено", zh: "已提交" },
	resultPulled: { en: "pulled", ru: "получено", zh: "已拉取" },
	resultPushed: { en: "pushed", ru: "отправлено", zh: "已推送" },
	resultMerged: { en: "merged", ru: "слито", zh: "已合并" },
	resultResolved: { en: "resolved", ru: "разрешено", zh: "已解决" },
	noticeConflicts: {
		en: "Git Vault Sync: {n} conflict(s) — resolve them in the dialog.",
		ru: "Git Vault Sync: конфликтов: {n} — разрешите их в диалоге.",
		zh: "Git Vault Sync：{n} 个冲突 — 请在对话框中解决。",
	},
	noticeAborted: {
		en: "Git Vault Sync: merge aborted, nothing changed",
		ru: "Git Vault Sync: слияние отменено, изменений нет",
		zh: "Git Vault Sync：合并已中止，未做任何更改",
	},
	noticeSyncFailed: { en: "Git Vault Sync: sync failed — {msg}", ru: "Git Vault Sync: ошибка синхронизации — {msg}", zh: "Git Vault Sync：同步失败 — {msg}" },
	noticeTesting: { en: "Git Vault Sync: testing connection…", ru: "Git Vault Sync: проверка соединения…", zh: "Git Vault Sync：正在测试连接…" },
	noticeConnected: {
		en: "Git Vault Sync: connected. Remote branches: {branches}",
		ru: "Git Vault Sync: подключено. Ветки на сервере: {branches}",
		zh: "Git Vault Sync：已连接。远程分支：{branches}",
	},
	noticeConnFailed: {
		en: "Git Vault Sync: connection failed — {msg}",
		ru: "Git Vault Sync: ошибка подключения — {msg}",
		zh: "Git Vault Sync：连接失败 — {msg}",
	},
	noticeResolveFailed: {
		en: "Git Vault Sync: resolve failed — {msg}",
		ru: "Git Vault Sync: ошибка разрешения — {msg}",
		zh: "Git Vault Sync：解决失败 — {msg}",
	},
	branchesNone: { en: "(none)", ru: "(нет)", zh: "（无）" },

	// --- progress (status bar during sync) ---
	progStaging: { en: "Staging changes…", ru: "Подготовка изменений…", zh: "正在暂存更改…" },
	progScanning: {
		en: "Scanning local files…",
		ru: "Сканирование локальных файлов…",
		zh: "正在扫描本地文件…",
	},
	progCommitting: { en: "Committing {n} change(s)…", ru: "Коммит изменений: {n}…", zh: "正在提交 {n} 个更改…" },
	progFetching: { en: "Fetching from remote…", ru: "Получение с сервера…", zh: "正在从远程获取…" },
	progMerging: { en: "Merging remote changes…", ru: "Слияние изменений…", zh: "正在合并远程更改…" },
	progPushing: { en: "Pushing to remote…", ru: "Отправка на сервер…", zh: "正在推送到远程…" },
	progPushingBatch: {
		en: "Pushing batch {n}/{total}…",
		ru: "Отправка части {n}/{total}…",
		zh: "正在推送第 {n}/{total} 批…",
	},
	progRemoteMoved: { en: "Remote moved — re-syncing…", ru: "Сервер изменился — повтор…", zh: "远程已变更 — 正在重新同步…" },
	progApplying: { en: "Applying resolutions…", ru: "Применение решений…", zh: "正在应用解决方案…" },
	progStagingMerge: { en: "Staging merge…", ru: "Подготовка слияния…", zh: "正在暂存合并…" },
	progMergeCommit: { en: "Creating merge commit…", ru: "Создание merge-коммита…", zh: "正在创建合并提交…" },
	progDeepening: {
		en: "Deepening shallow history…",
		ru: "Углубление истории…",
		zh: "正在加深浅历史…",
	},
	progInit: { en: "Initializing repository…", ru: "Инициализация репозитория…", zh: "正在初始化仓库…" },
	progLinking: { en: "Linking remote…", ru: "Привязка сервера…", zh: "正在关联远程…" },
	progCheckout: { en: "Checking out remote branch…", ru: "Переключение на ветку сервера…", zh: "正在检出远程分支…" },

	// --- errors (friendlyError) ---
	errAuth: {
		en: "Authentication failed — check your token and its repository permissions.",
		ru: "Ошибка авторизации — проверьте токен и его права на репозиторий.",
		zh: "认证失败 — 请检查你的令牌及其仓库权限。",
	},
	errNetwork: {
		en: "Network error — check your connection and the remote URL.",
		ru: "Сетевая ошибка — проверьте подключение и URL репозитория.",
		zh: "网络错误 — 请检查你的连接和远程地址。",
	},
	errTimeout: {
		en: "The remote didn't respond in time. Check your connection — syncing a large repository can take several minutes.",
		ru: "Сервер не ответил вовремя. Проверьте подключение — синхронизация большого репозитория может занять несколько минут.",
		zh: "远程未及时响应。请检查连接 — 同步大型仓库可能需要几分钟。",
	},
	errBadToken: {
		en: "Invalid or expired token.",
		ru: "Неверный или просроченный токен.",
		zh: "令牌无效或已过期。",
	},
	errNotFound: {
		en: "Remote or branch not found — check the URL and branch name.",
		ru: "Репозиторий или ветка не найдены — проверьте URL и имя ветки.",
		zh: "远程或分支未找到 — 请检查地址和分支名称。",
	},
	errTreeTruncated: {
		en: "The repository is too large for the API sync engine (GitHub returned a truncated file list). Sync was stopped to avoid data loss. Use the Git sync engine on desktop, or split the vault.",
		ru: "Репозиторий слишком большой для API-движка синхронизации (GitHub вернул усечённый список файлов). Синхронизация остановлена во избежание потери данных. Используйте Git-движок на десктопе или разделите хранилище.",
		zh: "仓库过大，超出了 API 同步引擎的处理能力（GitHub 返回了被截断的文件列表）。为避免数据丢失已停止同步。请在桌面端使用 Git 同步引擎，或拆分库。",
	},
	errPushRejected: {
		en: "Push rejected: the remote changed during sync. Run Sync again.",
		ru: "Отправка отклонена: сервер изменился во время синхронизации. Запустите синхронизацию снова.",
		zh: "推送被拒绝：同步期间远程发生了变化。请再次运行同步。",
	},
	errPushRule: {
		en: "GitHub rejected the push (branch protection or secret-scanning rule). Check Settings → Rules/Branches on GitHub, or sync to an unprotected branch.",
		ru: "GitHub отклонил push (защита ветки или правило сканирования секретов). Проверьте Settings → Rules/Branches на GitHub или синхронизируйте в незащищённую ветку.",
		zh: "GitHub 拒绝了推送（分支保护或密钥扫描规则）。请在 GitHub 的 设置 → 规则/分支 中检查，或同步到不受保护的分支。",
	},
	errRestoreFailed: {
		en: "Could not restore your deselected edits: {files}. Check disk space and recover them manually.",
		ru: "Не удалось восстановить ваши невыбранные правки: {files}. Проверьте свободное место и восстановите их вручную.",
		zh: "无法恢复你取消选择的编辑：{files}。请检查磁盘空间并手动恢复它们。",
	},
	errIndexVersion: {
		en: "The Git index was in an unsupported format and was rebuilt. Please try syncing again.",
		ru: "Индекс Git был в неподдерживаемом формате и пересоздан. Повторите синхронизацию.",
		zh: "Git 索引使用了不支持的格式，已重建。请重试同步。",
	},
	errShallowMerge: {
		en: "Could not merge on the mobile (shallow) clone — the histories diverged too far to find a common base. Sync from desktop once to reconcile them.",
		ru: "Не удалось выполнить слияние на мобильном (поверхностном) клоне — истории разошлись слишком сильно, общая база не найдена. Один раз синхронизируйтесь с десктопа, чтобы их свести.",
		zh: "无法在移动端（浅克隆）合并 — 历史分歧过大，找不到共同的基点。请先在桌面端同步一次以调和它们。",
	},
	errNoRemote: {
		en: "Set a repository URL in settings first.",
		ru: "Сначала укажите репозиторий в настройках.",
		zh: "请先在设置中填写仓库地址。",
	},

	// --- settings ---
	syncNow: { en: "Sync now", ru: "Синхронизировать", zh: "立即同步" },
	syncNowDesc: {
		en: "Stage, commit, pull and push your vault.",
		ru: "Подготовить, закоммитить, получить и отправить изменения хранилища.",
		zh: "暂存、提交、拉取并推送你的库。",
	},
	setRemoteName: { en: "Remote URL", ru: "URL репозитория", zh: "远程地址" },
	setRemoteDesc: {
		en: "HTTPS URL of the Git repository, e.g. https://github.com/user/vault.git",
		ru: "HTTPS-адрес Git-репозитория, напр. https://github.com/user/vault.git",
		zh: "Git 仓库的 HTTPS 地址，例如 https://github.com/user/vault.git",
	},
	setBranchName: { en: "Branch", ru: "Ветка", zh: "分支" },
	setBranchDesc: {
		en: "Branch to sync against. Refresh to load branches from the remote.",
		ru: "Ветка для синхронизации. Обновите, чтобы загрузить ветки с сервера.",
		zh: "要同步的分支。刷新以从远程加载分支。",
	},
	branchNew: { en: "➕ Create new branch…", ru: "➕ Создать новую ветку…", zh: "➕ 创建新分支…" },
	branchNewName: { en: "New branch name", ru: "Имя новой ветки", zh: "新分支名称" },
	branchBaseLabel: {
		en: "Created on the remote from base branch “{branch}”.",
		ru: "Будет создана на сервере от базовой ветки «{branch}».",
		zh: "在远程从基础分支“{branch}”创建。",
	},
	branchRefresh: {
		en: "Refresh branches from remote",
		ru: "Обновить ветки с сервера",
		zh: "从远程刷新分支",
	},
	branchFetching: { en: "Git Vault Sync: fetching branches…", ru: "Git Vault Sync: получение веток…", zh: "Git Vault Sync：正在获取分支…" },
	branchDone: { en: "Done", ru: "Готово", zh: "完成" },
	branchCreate: { en: "Create branch", ru: "Создать ветку", zh: "创建分支" },
	branchCreating: {
		en: "Git Vault Sync: creating branch “{branch}” on the remote…",
		ru: "Git Vault Sync: создание ветки «{branch}» на сервере…",
		zh: "Git Vault Sync：正在远程创建分支“{branch}”…",
	},
	branchCreated: {
		en: "Git Vault Sync: branch “{branch}” created on the remote.",
		ru: "Git Vault Sync: ветка «{branch}» создана на сервере.",
		zh: "Git Vault Sync：已在远程创建分支“{branch}”。",
	},
	branchCreateFailed: {
		en: "Git Vault Sync: couldn't create branch “{branch}” — {msg}",
		ru: "Git Vault Sync: не удалось создать ветку «{branch}» — {msg}",
		zh: "Git Vault Sync：无法创建分支“{branch}” — {msg}",
	},
	branchCreateNeedsGitHub: {
		en: "Creating a branch on the remote requires a GitHub HTTPS repository URL.",
		ru: "Создание ветки на сервере требует HTTPS-адрес репозитория GitHub.",
		zh: "在远程创建分支需要 GitHub HTTPS 仓库地址。",
	},
	branchBaseEmpty: {
		en: "Can't create a branch: the base branch “{branch}” doesn't exist on the remote yet (the repository may be empty). Push something first.",
		ru: "Не удалось создать ветку: базовой ветки «{branch}» ещё нет на сервере (репозиторий может быть пустым). Сначала отправьте что-нибудь.",
		zh: "无法创建分支：基础分支“{branch}”在远程尚不存在（仓库可能为空）。请先推送一些内容。",
	},
	branchInvalid: {
		en: "Invalid branch name. Avoid spaces, ~^:?*[ \\, '..', leading/trailing '/' or '.', and a '.lock' suffix.",
		ru: "Недопустимое имя ветки. Не используйте пробелы, ~^:?*[ \\, «..», слэш или точку в начале/конце и суффикс «.lock».",
		zh: "分支名无效。请避免空格、~^:?*[ \\\\、'..'、开头/结尾的 '/' 或 '.'，以及 '.lock' 后缀。",
	},
	hintRemoteSsh: {
		en: "This looks like an SSH URL. Git Vault Sync needs an HTTPS URL (https://…) with a Personal Access Token.",
		ru: "Похоже на SSH-адрес. Git Vault Sync нужен HTTPS-адрес (https://…) и персональный токен (PAT).",
		zh: "这看起来是 SSH 地址。Git Vault Sync 需要 HTTPS 地址（https://…）并配合个人访问令牌。",
	},
	hintRemoteNotHttps: {
		en: "This doesn't look like a valid HTTPS URL, e.g. https://github.com/user/vault.git",
		ru: "Это не похоже на корректный HTTPS-адрес, напр. https://github.com/user/vault.git",
		zh: "这看起来不是有效的 HTTPS 地址，例如 https://github.com/user/vault.git",
	},
	headAuth: { en: "Authentication", ru: "Авторизация", zh: "认证" },
	btnAuthorize: { en: "Authorize", ru: "Авторизоваться", zh: "授权" },
	authorizing: { en: "Authorizing…", ru: "Авторизация…", zh: "正在授权…" },
	authOk: {
		en: "Authorized as {user} — {count} repositories",
		ru: "Авторизованы как {user} — репозиториев: {count}",
		zh: "已授权为 {user} — {count} 个仓库",
	},
	authFailed: {
		en: "Git Vault Sync: authorization failed — {msg}",
		ru: "Git Vault Sync: ошибка авторизации — {msg}",
		zh: "Git Vault Sync：授权失败 — {msg}",
	},
	remoteSelectName: { en: "Repository", ru: "Репозиторий", zh: "仓库" },
	remoteSelectDesc: {
		en: "Pick a repository from your GitHub account, or enter a URL manually.",
		ru: "Выберите репозиторий из вашего аккаунта GitHub или введите URL вручную.",
		zh: "从你的 GitHub 账号中选择一个仓库，或手动输入地址。",
	},
	remoteManual: { en: "Enter manually…", ru: "Ввести вручную…", zh: "手动输入…" },
	setUserName: { en: "Username", ru: "Имя пользователя", zh: "用户名" },
	setUserDesc: { en: "Your GitHub username.", ru: "Ваше имя пользователя GitHub.", zh: "你的 GitHub 用户名。" },
	setTokenName: { en: "Personal Access Token", ru: "Персональный токен (PAT)", zh: "个人访问令牌" },
	setTokenDesc: {
		en: "Stored in plaintext in this plugin's data.json. Use a fine-grained token scoped to this repo (Contents: Read and write) with an expiration date.",
		ru: "Хранится в открытом виде в data.json плагина. Используйте fine-grained токен с доступом только к этому репозиторию (право Contents: чтение и запись) и сроком действия.",
		zh: "以明文存储在此插件的 data.json 中。请使用限定于此仓库的细粒度令牌（Contents：读取和写入），并设置过期日期。",
	},
	headCommits: { en: "Commits", ru: "Коммиты", zh: "提交" },
	setAuthorNameName: { en: "Author name", ru: "Имя автора", zh: "作者姓名" },
	setAuthorEmailName: { en: "Author email", ru: "Email автора", zh: "作者邮箱" },
	setCommitMsgName: { en: "Commit message", ru: "Сообщение коммита", zh: "提交消息" },
	setCommitMsgDesc: {
		en: "Template for sync commits. {{date}} is replaced with the current timestamp.",
		ru: "Шаблон для коммитов. {{date}} заменяется текущей датой и временем.",
		zh: "同步提交的消息模板。{{date}} 会被替换为当前时间戳。",
	},
	headAutoSync: { en: "Automatic sync", ru: "Автосинхронизация", zh: "自动同步" },
	setStartupName: { en: "Sync on startup", ru: "Синхронизация при запуске", zh: "启动时同步" },
	setStartupDesc: {
		en: "Run a sync once when Obsidian loads.",
		ru: "Выполнять синхронизацию один раз при запуске Obsidian.",
		zh: "Obsidian 加载时运行一次同步。",
	},
	setTimerName: { en: "Auto-sync on a timer", ru: "Автосинхронизация по таймеру", zh: "定时自动同步" },
	setTimerDesc: {
		en: "Periodically sync in the background.",
		ru: "Периодически синхронизировать в фоне.",
		zh: "在后台定期同步。",
	},
	setIntervalName: {
		en: "Auto-sync interval (minutes)",
		ru: "Интервал автосинхронизации (минуты)",
		zh: "自动同步间隔（分钟）",
	},
	setExcludeName: { en: "Excluded files & folders", ru: "Исключённые файлы и папки", zh: "排除的文件和文件夹" },
	setExcludeDesc: {
		en: "One pattern per line — files matching these are never committed or counted (e.g. *.tmp, secrets/). Use * within a folder, ** across folders, and a trailing / for a whole folder.",
		ru: "По одному шаблону на строку — совпавшие файлы не коммитятся и не считаются (напр. *.tmp, secrets/). * — внутри папки, ** — через папки, / в конце — вся папка.",
		zh: "每行一个模式 — 匹配这些模式的文件永远不会被提交或统计（例如 *.tmp、secrets/）。在文件夹内使用 *，跨文件夹使用 **，整个文件夹使用末尾的 /。",
	},
	setExcludeHint: {
		en: "These patterns (and the repo's .gitignore) apply on both the Git and GitHub API engines. Note: the GitHub API engine (used on mobile) always skips the whole config folder ({dir}) regardless of these patterns — it syncs only your notes, not Obsidian settings.",
		ru: "Эти шаблоны (и .gitignore репозитория) действуют в обоих движках — Git и GitHub API. Учтите: движок GitHub API (используется на мобильном) всегда пропускает всю папку конфигурации ({dir}) независимо от шаблонов — синхронизируются только заметки, а не настройки Obsidian.",
		zh: "这些模式（以及仓库的 .gitignore）在 Git 和 GitHub API 引擎上均生效。注意：GitHub API 引擎（用于移动端）无论如何都会跳过整个配置文件夹（{dir}）— 它只同步你的笔记，不同步 Obsidian 设置。",
	},
	headRepo: { en: "Repository", ru: "Репозиторий", zh: "仓库" },
	setInitName: { en: "Initialize / link repository", ru: "Инициализировать / привязать репозиторий", zh: "初始化 / 关联仓库" },
	setInitDesc: {
		en: "Set up Git in this vault: init if needed, link the remote above, fetch and check out its branch. Use this on a fresh vault.",
		ru: "Настроить Git в этом хранилище: инициализировать, привязать репозиторий, получить и переключиться на его ветку. Для нового хранилища.",
		zh: "在此库中设置 Git：如需要则初始化，关联上面的远程地址，获取并检出其分支。在全新库上使用。",
	},
	setInitButton: { en: "Initialize", ru: "Инициализировать", zh: "初始化" },
	setInitWorking: { en: "Working…", ru: "Выполняется…", zh: "处理中…" },
	noticeInitNeed: {
		en: "Git Vault Sync: set remote URL and token first",
		ru: "Git Vault Sync: сначала укажите URL и токен",
		zh: "Git Vault Sync：请先设置远程地址和令牌",
	},
	noticeInitReady: { en: "Git Vault Sync: repository ready", ru: "Git Vault Sync: репозиторий готов", zh: "Git Vault Sync：仓库已就绪" },
	noticeInitFailed: { en: "Git Vault Sync: init failed — {msg}", ru: "Git Vault Sync: ошибка инициализации — {msg}", zh: "Git Vault Sync：初始化失败 — {msg}" },
	setEngineName: { en: "Sync engine", ru: "Движок синхронизации", zh: "同步引擎" },
	setEngineDesc: {
		en: "Auto = API on mobile, Git on desktop. API avoids out-of-memory on large repos.",
		ru: "Авто = API на мобильном, Git на десктопе. API не вызывает нехватку памяти на больших репозиториях.",
		zh: "自动 = 移动端使用 API，桌面端使用 Git。API 可避免大型仓库的内存溢出。",
	},
	engineAuto: { en: "Auto (recommended)", ru: "Авто (рекомендуется)", zh: "自动（推荐）" },
	engineGit: { en: "Git (isomorphic-git)", ru: "Git (isomorphic-git)", zh: "Git（isomorphic-git）" },
	engineApi: { en: "GitHub API", ru: "GitHub API", zh: "GitHub API" },
	noticeApiNoSelective: {
		en: "Git Vault Sync: selective sync isn't available with the API engine — syncing everything.",
		ru: "Git Vault Sync: выборочная синхронизация недоступна с API-движком — синхронизируется всё.",
		zh: "Git Vault Sync：API 引擎不支持选择性同步 — 将同步所有内容。",
	},
	noticeApiNoReview: {
		en: "Git Vault Sync: Review changes isn't available with the API engine.",
		ru: "Git Vault Sync: просмотр изменений недоступен с API-движком.",
		zh: "Git Vault Sync：API 引擎不支持“查看更改”。",
	},
	setLangName: { en: "Language", ru: "Язык", zh: "语言" },
	setLangDesc: {
		en: "Interface language. Auto uses the system language (Russian, English, or Chinese).",
		ru: "Язык интерфейса. «Авто» использует язык системы (русский, английский или китайский).",
		zh: "界面语言。选择【自动】时，应用跟随系统语言，支持的系统语言：俄语、英语、中文。"
	},
	langAuto: { en: "Auto", ru: "Авто", zh: "自动" },
	langEn: { en: "English", ru: "English", zh: "English" },
	langRu: { en: "Русский", ru: "Русский", zh: "Русский" },
	langZh: { en: "中文", ru: "中文", zh: "中文" },

	// --- conflict modal ---
	cmTitle: { en: "Resolve {n} merge conflict(s)", ru: "Разрешите конфликты слияния: {n}", zh: "解决 {n} 个合并冲突" },
	cmIntro: {
		en: "For each file choose which version to keep, or edit the merged result manually.",
		ru: "Для каждого файла выберите версию или отредактируйте результат вручную.",
		zh: "为每个文件选择要保留的版本，或手动编辑合并结果。",
	},
	cmLoading: { en: "Loading versions…", ru: "Загрузка версий…", zh: "正在加载版本…" },
	cmFailed: { en: "Failed to read changes: {msg}", ru: "Не удалось прочитать изменения: {msg}", zh: "读取更改失败：{msg}" },
	cmResolution: { en: "Resolution", ru: "Решение", zh: "解决方式" },
	cmOptManual: { en: "Edit manually", ru: "Редактировать вручную", zh: "手动编辑" },
	cmOptLocal: { en: "Use local (ours)", ru: "Локальная версия", zh: "使用本地（ours）" },
	cmOptRemote: { en: "Use remote (theirs)", ru: "Версия с сервера", zh: "使用远程（theirs）" },
	cmShow: { en: "Show local / remote", ru: "Показать локальную / серверную", zh: "显示本地 / 远程" },
	cmDeleted: { en: "(file deleted)", ru: "(файл удалён)", zh: "（文件已删除）" },
	cmBinary: {
		en: "Binary file — choose which whole version to keep (no text preview).",
		ru: "Бинарный файл — выберите, какую версию целиком оставить (без предпросмотра).",
		zh: "二进制文件 — 选择保留哪个完整版本（无文本预览）。",
	},
	cmResolve: { en: "Resolve & sync", ru: "Разрешить и синхронизировать", zh: "解决并同步" },
	cmSyncing: { en: "Syncing…", ru: "Синхронизация…", zh: "正在同步…" },
	cmCancel: { en: "Cancel (abort merge)", ru: "Отмена (прервать слияние)", zh: "取消（中止合并）" },
	// wizard navigation (one conflict per step, mobile-friendly)
	cmProgress: { en: "Conflict {i} of {n}", ru: "Конфликт {i} из {n}", zh: "冲突 {i} / {n}" },
	cmBack: { en: "Back", ru: "Назад", zh: "上一步" },
	cmAllLocal: { en: "Use local for all", ru: "Локальные версии для всех", zh: "全部使用本地" },
	cmAllRemote: { en: "Use remote for all", ru: "Версии с сервера для всех", zh: "全部使用远程" },
	cmNext: { en: "Next", ru: "Далее", zh: "下一步" },

	// --- API conflict modal (Git Data API sync) ---
	acmTitle: {
		en: "Resolve {n} conflict(s)",
		ru: "Разрешите конфликты: {n}",
		zh: "解决 {n} 个冲突",
	},
	acmIntro: {
		en: "For each file choose which version to keep, or edit the merged result manually. Your choices are committed and pushed.",
		ru: "Для каждого файла выберите версию или отредактируйте результат вручную. Выбор будет закоммичен и отправлен.",
		zh: "为每个文件选择要保留的版本，或手动编辑合并结果。你的选择将被提交并推送。",
	},
	acmBinary: {
		en: "(binary file — preview unavailable)",
		ru: "(бинарный файл — предпросмотр недоступен)",
		zh: "（二进制文件 — 无法预览）",
	},
	acmLocalDeleted: {
		en: "Keep deleted (local)",
		ru: "Оставить удалённым (локально)",
		zh: "保留已删除（本地）",
	},
	acmRemoteDeleted: {
		en: "Delete (remote)",
		ru: "Удалить (как на сервере)",
		zh: "删除（远程）",
	},
	acmResolve: { en: "Resolve & sync", ru: "Разрешить и синхронизировать", zh: "解决并同步" },
	acmCancel: { en: "Cancel", ru: "Отмена", zh: "取消" },
	apiSyncResolving: {
		en: "Git Vault Sync: applying conflict resolutions…",
		ru: "Git Vault Sync: применение разрешений конфликтов…",
		zh: "Git Vault Sync：正在应用冲突解决方案…",
	},
	apiSyncResolved: {
		en: "Git Vault Sync: {n} conflict(s) resolved.",
		ru: "Git Vault Sync: разрешено конфликтов: {n}.",
		zh: "Git Vault Sync：已解决 {n} 个冲突。",
	},
	apiSyncResolveCancelled: {
		en: "Git Vault Sync: conflict resolution cancelled — nothing changed.",
		ru: "Git Vault Sync: разрешение конфликтов отменено — изменений нет.",
		zh: "Git Vault Sync：冲突解决已取消 — 未做任何更改。",
	},
	apiSyncResolveFailed: {
		en: "Git Vault Sync: applying resolutions failed — {msg}",
		ru: "Git Vault Sync: ошибка применения разрешений — {msg}",
		zh: "Git Vault Sync：应用解决方案失败 — {msg}",
	},

	// --- review modal ---
	rmTitle: { en: "Review changes", ru: "Просмотр изменений", zh: "查看更改" },
	rmLoading: { en: "Loading changes…", ru: "Загрузка изменений…", zh: "正在加载更改…" },
	rmFailed: { en: "Failed to read changes: {msg}", ru: "Не удалось прочитать изменения: {msg}", zh: "读取更改失败：{msg}" },
	rmNothing: { en: "Nothing to commit — up to date.", ru: "Нечего коммитить — всё актуально.", zh: "没有可提交的内容 — 已是最新。" },
	rmClose: { en: "Close", ru: "Закрыть", zh: "关闭" },
	rmCount: { en: "{n} changed file(s)", ru: "изменённых файлов: {n}", zh: "{n} 个已更改文件" },
	rmSelectAll: { en: "Select all", ru: "Выбрать все", zh: "全选" },
	rmSelectNone: { en: "Select none", ru: "Снять все", zh: "全不选" },
	rmSync: { en: "Sync {n} selected", ru: "Синхронизировать выбранные: {n}", zh: "同步选中的 {n} 项" },
	rmCancel: { en: "Cancel", ru: "Отмена", zh: "取消" },
};

let current: Lang = "en";

/** Resolve and store the active language from the user's preference. */
export function setLanguage(pref: LangPref): void {
	if (pref === "en" || pref === "ru" || pref === "zh") {
		current = pref;
		return;
	}
	// Electron and mobile WebViews expose the system's preferred locale here.
	const locale = typeof navigator === "undefined" ? "" : navigator.language;
	if (/^ru(?:[-_]|$)/i.test(locale ?? "")) {
		current = "ru";
	} else if (/^zh(?:[-_]|$)/i.test(locale ?? "")) {
		current = "zh";
	} else {
		current = "en";
	}
}


export function getCurrentLanguage(): Lang { return current; }

/** Translate a key, substituting `{name}` placeholders from `vars`. */
export function t(key: keyof typeof STRINGS, vars?: Record<string, string | number>): string {
	const entry = STRINGS[key];
	let s = entry ? entry[current] ?? entry.en : String(key);
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			// Replace every occurrence (split/join avoids needing replaceAll).
			s = s.split(`{${k}}`).join(String(v));
		}
	}
	return s;
}
