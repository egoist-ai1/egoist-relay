# Bridge readiness remediation: source candidate

Исправлены воспроизведённые отказы во время обновления DOM account proof. Проверка исходников завершена: SocialMCP 178/178 и final native 40/40 PASS. Установленный Relay 1.4.2 этим worker не заменялся.

## Проверки

- Baseline actual broker: 14 проверок, 2 PASS / 12 ожидаемых FAIL до исправления.
- Полная SocialMCP suite: 178/178 PASS, 0 failed / 0 skipped; 23921.7737 ms. Новых 23 case: 18 broker + 5 authenticated IPC.
- Независимый reviewer: 26/26 broker/IPC PASS, 4657.3674 ms; 23 worker cases и 3 дополнительные adversarial boundaries.
- Node --check broker/ipc PASS. Parent final native c10f737: 40/40 PASS, включая 4 новые actual-function lifecycle regressions. Metadata на этапе проверки ещё 1.4.3; root выполнит release-version fixture после собственного bump.
- Независимые Rust fixtures: 5/5 PASS на exact final functions. Они проверяют старые документы, fresh guard после replacement, late redirect и strict dispatch bindings.
- Дополнительный independent real-clock test: три tail submissions завершились за 20,013.54–20,013.64 ms; 0 durable jobs, 0 outputs, 0 source runs. Таймеры не ускорялись.
- [Independent project receipt](<C:/Users/Egoist/Desktop/Проекты/Инфраструктура/Egoist Social MCP/docs/app-quality-audit-2026-10-02/bridge-readiness-independent-review.json>) сверён по exact SHA256; [review Markdown](<C:/Users/Egoist/Desktop/Проекты/Инфраструктура/Egoist Social MCP/docs/app-quality-audit-2026-10-02/bridge-readiness-independent-review.md>) хранит отдельные выводы. English-space correction в BRIDGE paragraph не меняет protocol behavior.
- [Полный output SocialMCP suite](bridge-readiness-fix-tests.txt) сохраняет точные результаты synthetic проверок.
- Runtime social-read.js 162335ec… и immutable before audit22 сохранены без правок.

## Точные файлы

| Файл | SHA256 |
| --- | --- |
| C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\broker.mjs | `f5e06381547f042777cc05e48a006ee971451110e2d20eaf3bd3821d5a0807fb` |
| C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\ipc.mjs | `4db64742af2a2c7d02e404a7877ff5f1e5ebb85e0e4dc2adacc13063f4bc9e96` |
| C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\broker-readiness-fix.test.mjs | `a3d889f6a06467227163bd3af47c13bc9ea0522513e68602a0c2fd2a7e3152ac` |
| C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\ipc-readiness-fix.test.mjs | `b559d1e8da9d28de80c5265fc1667beae782d7614b05c72073d6cef067737389` |
| C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\src\research\broker.test.mjs | `360395dd96a2061f3f42a1b45a6ca071e3845504272ff2817060814080983c98` |
| C:\Users\Egoist\Desktop\Проекты\Инфраструктура\Egoist Social MCP\BRIDGE-CONTRACT.md | `cc1878eb7f0c153e54986128b93cdab0e708145154b84697550f0b76aec38abb` |
| C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\tauri\src\research_social.rs | `c10f737215e3acafaec73d87aa88490dccc4cb45211eb03a58da3a696f7beaa8` |
| C:\Users\Egoist\Desktop\Проекты\Приложения\Egoist Relay\runtime\research\social-read.js | `162335eccc2d6ff1676cd6fc069ce9b62bef077d89a4857ace392ade9450ddd8` |

<a id="settled-proof"></a>
## Подтверждённый proof до account pin

Только явные dom_account_proof_pending и app_initializing ожидаются до 20 секунд включая serialized tail. Окончательные auth/challenge/rate/transport ошибки не создают новый job. На dequeue ready должен точно совпасть с исходным account pin; pending identity не сохраняется.

Подтверждение: Принять bounded readiness semantics и сохранить genuine account rejection.

<a id="ipc-commit"></a>
## Разрыв IPC и граница durable commit

Authenticated submit/submit_join передают внутренний AbortSignal только до commit. Close во время tail/proof оставляет 0 durable jobs и 0 source runs. Начатый atomic save может дать unknown completion; durable поручение сохраняется с exact idempotency. Прерванная allocation может оставить только собственный пустой output directory, без удаления соседних данных.

Подтверждение: Принять commit/recovery semantics; не включать автоматическую отмену принятого задания.

<a id="one-budget"></a>
## Один срок выполнения без скрытого удвоения

Один абсолютный deadline после dequeue включает readiness/busy wait, source, checkpoints и completion persistence; adapter получает остаток. Время в очереди до dequeue отделено. Поздняя source/save completion не переписывает interruption.

Подтверждение: Принять remaining deadline при неизменных persisted finite job limits.

<a id="native-init"></a>
## Native dispatch после initialization

Windows сначала создаёт about:blank, затем подтверждает регистрацию SDK observers через bounded 2s ack и выполняет одну target navigation. DOMContentLoaded запускает только Probe; NavigationCompleted с текущим ID сохраняет collection gate и fallback. Повтор dispatch в том же document epoch подавляется.

Подтверждение: Принять Windows SDK lifecycle при отдельном actual COM/live gate.

<a id="native-owner"></a>
## Владелец навигации и строгие guards

NavigationOwner фиксируется при новом NavigationStarting. Guard и failure path требуют тот же request/nonce/phase/accountEpoch/target/page context, generation, NavigationId, documentEpoch и exact first-party source. Поздний redirect старого ID отклоняется; redirect того же ID не меняет owner. Fresh guard после replacement до его собственной navigation запрещён.

Подтверждение: Принять owner-binding correction без ослабления account/origin/source guards.

<a id="live-gate"></a>
## Source проверки и новая сборка остаются разными evidence

SocialMCP 178/178, final native 40/40 и независимые 26 broker/IPC + 5 Rust synthetic checks не доказывают поведение установленной версии 1.4.2. Новые sources не активированы этим worker. Live idle >15s → submit/dequeue и slow-navigation/account negatives остаются root acceptance после обычного owner transition.

Подтверждение: Сохранить live gate и не заявлять installed repair до actual новой сборки.

## Ограничения evidence

Parent 13 readonly samples на установленном 1.4.2 показывают повторный TTL transient около 2.5 секунды, а не logout. Исходный [audit22](bridge-account-readiness-audit.json) сохранён неизменным; его old inputs/results нельзя переносить на новый EXE.

Submit budget 20s включает serialized tail и finite provider.status RPC 5s; daemon socket timeout 30s, default client 35s. Signal не является частью wire schema. MAC/hello и отдельный exact-target submit_join сохранены. Close до commit оставляет 0 durable jobs / 0 runs. Начатый atomic save может принять persistent job даже после разрыва ответа; требуется исходный idempotency/readback. Без исходного idempotency key uncertain response может не дать exact job-ID recovery. Blind retry не обещается.

После отменённой allocation собственная пустая directory остаётся явным незавершённым действием; соседние пути не удаляются. При deadline во время final write память остаётся running до durable settlement, а interruption последовательно сохраняется после поздней completion write.

Windows SDK observers регистрируются до target navigation; worker ждёт фактический ack в пределах 2s. ContentLoading только увеличивает documentEpoch, SDK DOMContentLoaded после init запускает Probe. Collection сохраняет NavigationCompleted gate. Tauri Finished без NavigationId на Windows не используется.

Native pure tests проверяют actual guard/envelope/owner functions; это не execution WebView2 COM или live platform DOM. Non-Windows имеет прежний Tauri lifecycle. Account selectors/storage invalidation не изменены; account pin, source/origin/nonce/epoch validation и finite bounds не ослаблены.

## Live gate

- New installed exact EXE/helper/runtime identity verified after human normal exit and root activation
- Idle >15s proof renewal: submit settles before pin and dequeue stays FIFO without false PROVIDER_UNAVAILABLE/STALE_ACCOUNT
- Slow Finished: current DOMContentLoaded probe replies within existing bound; old/redirect/cancel/epoch replies still rejected
- Public X/IG bounded read/export/resume/media acceptance on new actual compiled script; no source operation automatically repeated

## Обратная связь

Снимок: [bridge-readiness-fix-report.json](bridge-readiness-fix-report.json). Exact UTF-8 bytes SHA256: `28eae23fbf1ea99e9bde3021a6874a6520d1e2295dfe9bd7e429dd9748d6b844`.

Шесть neutral reviewObjects предназначены parent companion board: ✓ Да / подтверждаю, ✕ Нет, ? Поясни и комментарий для каждого; общий комментарий и Применить. Решения по умолчанию не выбраны, ответы сохраняются отдельно. Подтверждение принимает semantics/evidence; не выполняет install/login/platform action.
