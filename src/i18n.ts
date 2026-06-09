/**
 * Tiny i18n for GitSync. Strings are keyed; each key has an `en` and `ru`
 * value. The active language is chosen from the plugin's "Language" setting,
 * which defaults to following Obsidian's own UI language.
 */
export type Lang = "en" | "ru";
export type LangPref = "auto" | Lang;

const STRINGS: Record<string, Record<Lang, string>> = {
	// --- ribbon / commands ---
	ribbonSync: { en: "GitSync: Sync vault", ru: "GitSync: синхронизировать хранилище" },
	ribbonReview: {
		en: "GitSync: Review changes & sync",
		ru: "GitSync: просмотреть изменения и синхронизировать",
	},
	cmdSync: { en: "Sync vault with Git", ru: "Синхронизировать хранилище с Git" },
	cmdReview: {
		en: "Review changes & sync",
		ru: "Просмотреть изменения и синхронизировать",
	},
	cmdTest: { en: "Test connection to remote", ru: "Проверить соединение с сервером" },

	// --- status-bar menu ---
	menuSyncNow: { en: "Sync now", ru: "Синхронизировать сейчас" },
	menuTest: { en: "Test connection", ru: "Проверить соединение" },
	menuSettings: { en: "Open settings", ru: "Открыть настройки" },

	// --- status bar ---
	statusSyncing: { en: "syncing…", ru: "синхронизация…" },
	statusError: { en: "error", ru: "ошибка" },
	statusConflict: { en: "conflict", ru: "конфликт" },
	tipSyncing: { en: "GitSync: syncing…", ru: "GitSync: синхронизация…" },
	tipError: {
		en: "GitSync: last sync failed — click to retry",
		ru: "GitSync: последняя синхронизация не удалась — нажмите, чтобы повторить",
	},
	tipConflict: {
		en: "GitSync: merge conflict — tap to resolve",
		ru: "GitSync: конфликт слияния — нажмите, чтобы разрешить",
	},
	menuResolve: { en: "Resolve conflict", ru: "Разрешить конфликт" },
	tipChanges: {
		en: "GitSync: {n} change(s) to sync · last sync {last} · click for options",
		ru: "GitSync: изменений к синхронизации: {n} · последняя {last} · нажмите для меню",
	},
	tipClean: {
		en: "GitSync: up to date · last sync {last} · click for options",
		ru: "GitSync: актуально · последняя синхронизация {last} · нажмите для меню",
	},
	lastNever: { en: "never", ru: "никогда" },
	lastJustNow: { en: "just now", ru: "только что" },
	lastMin: { en: "{n} min ago", ru: "{n} мин назад" },
	lastHour: { en: "{n} h ago", ru: "{n} ч назад" },
	lastDay: { en: "{n} d ago", ru: "{n} дн назад" },

	// --- sync notices ---
	noticeInProgress: {
		en: "GitSync: sync already in progress",
		ru: "GitSync: синхронизация уже идёт",
	},
	noticeConfigure: {
		en: "GitSync: configure remote URL and token in settings first",
		ru: "GitSync: сначала укажите URL репозитория и токен в настройках",
	},
	noticeResult: { en: "GitSync: {parts}", ru: "GitSync: {parts}" },
	resultUpToDate: { en: "already up to date", ru: "уже актуально" },
	resultCommitted: { en: "committed", ru: "закоммичено" },
	resultPulled: { en: "pulled", ru: "получено" },
	resultPushed: { en: "pushed", ru: "отправлено" },
	resultMerged: { en: "merged", ru: "слито" },
	resultResolved: { en: "resolved", ru: "разрешено" },
	noticeConflicts: {
		en: "GitSync: {n} conflict(s) — resolve them in the dialog.",
		ru: "GitSync: конфликтов: {n} — разрешите их в диалоге.",
	},
	noticeAborted: {
		en: "GitSync: merge aborted, nothing changed",
		ru: "GitSync: слияние отменено, изменений нет",
	},
	noticeSyncFailed: { en: "GitSync: sync failed — {msg}", ru: "GitSync: ошибка синхронизации — {msg}" },
	noticeTesting: { en: "GitSync: testing connection…", ru: "GitSync: проверка соединения…" },
	noticeConnected: {
		en: "GitSync: connected. Remote branches: {branches}",
		ru: "GitSync: подключено. Ветки на сервере: {branches}",
	},
	noticeConnFailed: {
		en: "GitSync: connection failed — {msg}",
		ru: "GitSync: ошибка подключения — {msg}",
	},
	noticeResolveFailed: {
		en: "GitSync: resolve failed — {msg}",
		ru: "GitSync: ошибка разрешения — {msg}",
	},
	branchesNone: { en: "(none)", ru: "(нет)" },

	// --- progress (status bar during sync) ---
	progStaging: { en: "Staging changes…", ru: "Подготовка изменений…" },
	progCommitting: { en: "Committing {n} change(s)…", ru: "Коммит изменений: {n}…" },
	progFetching: { en: "Fetching from remote…", ru: "Получение с сервера…" },
	progMerging: { en: "Merging remote changes…", ru: "Слияние изменений…" },
	progPushing: { en: "Pushing to remote…", ru: "Отправка на сервер…" },
	progRemoteMoved: { en: "Remote moved — re-syncing…", ru: "Сервер изменился — повтор…" },
	progApplying: { en: "Applying resolutions…", ru: "Применение решений…" },
	progStagingMerge: { en: "Staging merge…", ru: "Подготовка слияния…" },
	progMergeCommit: { en: "Creating merge commit…", ru: "Создание merge-коммита…" },
	progDeepening: {
		en: "Deepening shallow history…",
		ru: "Углубление истории…",
	},
	progInit: { en: "Initializing repository…", ru: "Инициализация репозитория…" },
	progLinking: { en: "Linking remote…", ru: "Привязка сервера…" },
	progCheckout: { en: "Checking out remote branch…", ru: "Переключение на ветку сервера…" },

	// --- errors (friendlyError) ---
	errAuth: {
		en: "Authentication failed — check your token and its repository permissions.",
		ru: "Ошибка авторизации — проверьте токен и его права на репозиторий.",
	},
	errNetwork: {
		en: "Network error — check your connection and the remote URL.",
		ru: "Сетевая ошибка — проверьте подключение и URL репозитория.",
	},
	errBadToken: {
		en: "Invalid or expired token.",
		ru: "Неверный или просроченный токен.",
	},
	errNotFound: {
		en: "Remote or branch not found — check the URL and branch name.",
		ru: "Репозиторий или ветка не найдены — проверьте URL и имя ветки.",
	},
	errPushRejected: {
		en: "Push rejected: the remote changed during sync. Run Sync again.",
		ru: "Отправка отклонена: сервер изменился во время синхронизации. Запустите синхронизацию снова.",
	},
	errRestoreFailed: {
		en: "Could not restore your deselected edits: {files}. Check disk space and recover them manually.",
		ru: "Не удалось восстановить ваши невыбранные правки: {files}. Проверьте свободное место и восстановите их вручную.",
	},
	errIndexVersion: {
		en: "The Git index was in an unsupported format and was rebuilt. Please try syncing again.",
		ru: "Индекс Git был в неподдерживаемом формате и пересоздан. Повторите синхронизацию.",
	},
	errShallowMerge: {
		en: "Could not merge on the mobile (shallow) clone — the histories diverged too far to find a common base. Sync from desktop once to reconcile them.",
		ru: "Не удалось выполнить слияние на мобильном (поверхностном) клоне — истории разошлись слишком сильно, общая база не найдена. Один раз синхронизируйтесь с десктопа, чтобы их свести.",
	},
	errNoRemote: {
		en: "Set a repository URL in settings first.",
		ru: "Сначала укажите репозиторий в настройках.",
	},

	// --- settings ---
	syncNow: { en: "Sync now", ru: "Синхронизировать" },
	syncNowDesc: {
		en: "Stage, commit, pull and push your vault.",
		ru: "Подготовить, закоммитить, получить и отправить изменения хранилища.",
	},
	setRemoteName: { en: "Remote URL", ru: "URL репозитория" },
	setRemoteDesc: {
		en: "HTTPS URL of the Git repository, e.g. https://github.com/user/vault.git",
		ru: "HTTPS-адрес Git-репозитория, напр. https://github.com/user/vault.git",
	},
	setBranchName: { en: "Branch", ru: "Ветка" },
	setBranchDesc: {
		en: "Branch to sync against. Refresh to load branches from the remote.",
		ru: "Ветка для синхронизации. Обновите, чтобы загрузить ветки с сервера.",
	},
	branchNew: { en: "➕ Create new branch…", ru: "➕ Создать новую ветку…" },
	branchNewName: { en: "New branch name", ru: "Имя новой ветки" },
	branchRefresh: {
		en: "Refresh branches from remote",
		ru: "Обновить ветки с сервера",
	},
	branchFetching: { en: "GitSync: fetching branches…", ru: "GitSync: получение веток…" },
	branchDone: { en: "Done", ru: "Готово" },
	branchInvalid: {
		en: "Invalid branch name. Avoid spaces, ~^:?*[ \\, '..', leading/trailing '/' or '.', and a '.lock' suffix.",
		ru: "Недопустимое имя ветки. Не используйте пробелы, ~^:?*[ \\, «..», слэш или точку в начале/конце и суффикс «.lock».",
	},
	hintRemoteSsh: {
		en: "This looks like an SSH URL. GitSync needs an HTTPS URL (https://…) with a Personal Access Token.",
		ru: "Похоже на SSH-адрес. GitSync нужен HTTPS-адрес (https://…) и персональный токен (PAT).",
	},
	hintRemoteNotHttps: {
		en: "This doesn't look like a valid HTTPS URL, e.g. https://github.com/user/vault.git",
		ru: "Это не похоже на корректный HTTPS-адрес, напр. https://github.com/user/vault.git",
	},
	headAuth: { en: "Authentication", ru: "Авторизация" },
	btnAuthorize: { en: "Authorize", ru: "Авторизоваться" },
	authorizing: { en: "Authorizing…", ru: "Авторизация…" },
	authOk: {
		en: "Authorized as {user} — {count} repositories",
		ru: "Авторизованы как {user} — репозиториев: {count}",
	},
	authFailed: {
		en: "GitSync: authorization failed — {msg}",
		ru: "GitSync: ошибка авторизации — {msg}",
	},
	remoteSelectName: { en: "Repository", ru: "Репозиторий" },
	remoteSelectDesc: {
		en: "Pick a repository from your GitHub account, or enter a URL manually.",
		ru: "Выберите репозиторий из вашего аккаунта GitHub или введите URL вручную.",
	},
	remoteManual: { en: "Enter manually…", ru: "Ввести вручную…" },
	setUserName: { en: "Username", ru: "Имя пользователя" },
	setUserDesc: { en: "Your GitHub username.", ru: "Ваше имя пользователя GitHub." },
	setTokenName: { en: "Personal Access Token", ru: "Персональный токен (PAT)" },
	setTokenDesc: {
		en: "Stored in plaintext in this plugin's data.json. Use a fine-grained token scoped to this repo.",
		ru: "Хранится в открытом виде в data.json плагина. Используйте токен с доступом только к этому репозиторию.",
	},
	headCommits: { en: "Commits", ru: "Коммиты" },
	setAuthorNameName: { en: "Author name", ru: "Имя автора" },
	setAuthorEmailName: { en: "Author email", ru: "Email автора" },
	setCommitMsgName: { en: "Commit message", ru: "Сообщение коммита" },
	setCommitMsgDesc: {
		en: "Template for sync commits. {{date}} is replaced with the current timestamp.",
		ru: "Шаблон для коммитов. {{date}} заменяется текущей датой и временем.",
	},
	headAutoSync: { en: "Automatic sync", ru: "Автосинхронизация" },
	setStartupName: { en: "Sync on startup", ru: "Синхронизация при запуске" },
	setStartupDesc: {
		en: "Run a sync once when Obsidian loads.",
		ru: "Выполнять синхронизацию один раз при запуске Obsidian.",
	},
	setTimerName: { en: "Auto-sync on a timer", ru: "Автосинхронизация по таймеру" },
	setTimerDesc: {
		en: "Periodically sync in the background.",
		ru: "Периодически синхронизировать в фоне.",
	},
	setIntervalName: {
		en: "Auto-sync interval (minutes)",
		ru: "Интервал автосинхронизации (минуты)",
	},
	setExcludeName: { en: "Excluded files & folders", ru: "Исключённые файлы и папки" },
	setExcludeDesc: {
		en: "One pattern per line — files matching these are never committed or counted (e.g. *.tmp, .obsidian/workspace.json). Use * within a folder, ** across folders, and a trailing / for a whole folder.",
		ru: "По одному шаблону на строку — совпавшие файлы не коммитятся и не считаются (напр. *.tmp, .obsidian/workspace.json). * — внутри папки, ** — через папки, / в конце — вся папка.",
	},
	headRepo: { en: "Repository", ru: "Репозиторий" },
	setInitName: { en: "Initialize / link repository", ru: "Инициализировать / привязать репозиторий" },
	setInitDesc: {
		en: "Set up Git in this vault: init if needed, link the remote above, fetch and check out its branch. Use this on a fresh vault.",
		ru: "Настроить Git в этом хранилище: инициализировать, привязать репозиторий, получить и переключиться на его ветку. Для нового хранилища.",
	},
	setInitButton: { en: "Initialize", ru: "Инициализировать" },
	setInitWorking: { en: "Working…", ru: "Выполняется…" },
	noticeInitNeed: {
		en: "GitSync: set remote URL and token first",
		ru: "GitSync: сначала укажите URL и токен",
	},
	noticeInitReady: { en: "GitSync: repository ready", ru: "GitSync: репозиторий готов" },
	noticeInitFailed: { en: "GitSync: init failed — {msg}", ru: "GitSync: ошибка инициализации — {msg}" },
	setLangName: { en: "Language", ru: "Язык" },
	setLangDesc: {
		en: "Interface language. Auto follows Obsidian's language.",
		ru: "Язык интерфейса. «Авто» следует языку Obsidian.",
	},
	langAuto: { en: "Auto", ru: "Авто" },
	langEn: { en: "English", ru: "English" },
	langRu: { en: "Русский", ru: "Русский" },

	// --- conflict modal ---
	cmTitle: { en: "Resolve {n} merge conflict(s)", ru: "Разрешите конфликты слияния: {n}" },
	cmIntro: {
		en: "For each file choose which version to keep, or edit the merged result manually.",
		ru: "Для каждого файла выберите версию или отредактируйте результат вручную.",
	},
	cmLoading: { en: "Loading versions…", ru: "Загрузка версий…" },
	cmFailed: { en: "Failed to read changes: {msg}", ru: "Не удалось прочитать изменения: {msg}" },
	cmResolution: { en: "Resolution", ru: "Решение" },
	cmOptManual: { en: "Edit manually", ru: "Редактировать вручную" },
	cmOptLocal: { en: "Use local (ours)", ru: "Локальная версия" },
	cmOptRemote: { en: "Use remote (theirs)", ru: "Версия с сервера" },
	cmShow: { en: "Show local / remote", ru: "Показать локальную / серверную" },
	cmDeleted: { en: "(file deleted)", ru: "(файл удалён)" },
	cmResolve: { en: "Resolve & sync", ru: "Разрешить и синхронизировать" },
	cmSyncing: { en: "Syncing…", ru: "Синхронизация…" },
	cmCancel: { en: "Cancel (abort merge)", ru: "Отмена (прервать слияние)" },

	// --- review modal ---
	rmTitle: { en: "Review changes", ru: "Просмотр изменений" },
	rmLoading: { en: "Loading changes…", ru: "Загрузка изменений…" },
	rmFailed: { en: "Failed to read changes: {msg}", ru: "Не удалось прочитать изменения: {msg}" },
	rmNothing: { en: "Nothing to commit — up to date.", ru: "Нечего коммитить — всё актуально." },
	rmClose: { en: "Close", ru: "Закрыть" },
	rmCount: { en: "{n} changed file(s)", ru: "изменённых файлов: {n}" },
	rmSelectAll: { en: "Select all", ru: "Выбрать все" },
	rmSelectNone: { en: "Select none", ru: "Снять все" },
	rmSync: { en: "Sync {n} selected", ru: "Синхронизировать выбранные: {n}" },
	rmCancel: { en: "Cancel", ru: "Отмена" },
};

let current: Lang = "en";

/** Resolve and store the active language from the user's preference. */
export function setLanguage(pref: LangPref): void {
	if (pref === "en" || pref === "ru") {
		current = pref;
		return;
	}
	// Auto: follow Obsidian's UI language (stored in localStorage).
	const obsidianLang = window.localStorage.getItem("language");
	current = obsidianLang === "ru" ? "ru" : "en";
}

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
