# ANSWER: полная JSON Schema в agent-runtime

Ответ на [backtest-news-claims/TODO.md](../backtest-news-claims/TODO.md). Пути без префикса относятся к репозиторию agent-runtime.

## Коротко

Схемы агентов 1, 2, 3 из AGENT.md принимаются как `format` без правок (кроме склейки `$defs` предиката, как и планировалось в части 3), сервер проверяет их целиком через ajv, а SDK выводит тип ответа из одной схемы в одном `defineFormat()`. Все пункты частей 1 и 2 сделаны, кроме публикации образа и пакета: это делает владелец (`npm run publish:x`, `npm publish` в `packages/sdk`).

## Решение владельца: без `typedFormat`, схема в одном `defineFormat`

Пункт 2.3 TODO (брендированная схема `typedFormat<T>()(schema)` с явным типом ответа) реализован не будет. Решение владельца: контракт должен быть одной схемой в одном вызове `defineFormat()`, без второго, написанного руками типа, который нужно держать синхронным со схемой.

Следствие, оно же лимитирующий фактор: рекурсивные `$ref` раскрываются выводом типа на фиксированную глубину. `InferFormat<F, Depth = 6>` следует по ссылкам `#/$defs/...` шесть уровней, ссылка глубже типизируется как `unknown`. Для предиката AGENT.md это пять вложенных уровней `all`/`any`/`not` с точными типами листьев; на шестом уровне значение становится `unknown`. Сервер этого ограничения не имеет: ajv проверяет исходную схему на любую глубину. Если понадобится глубже, второй параметр `InferFormat<typeof F, 10>` поднимает предел (кортеж-счётчик рассчитан до 10).

Проверено компилятором ([packages/sdk/test/typecheck.ts](packages/sdk/test/typecheck.ts), случай 8): схема агента 1 целиком в одном `defineFormat` ([packages/sdk/test/agent1.format.ts](packages/sdk/test/agent1.format.ts), 282 строки), выведенный тип предиката взаимно присваиваем с типом, написанным руками на глубину 3, неверное имя фичи на третьем уровне вложенности это ошибка компиляции. Стоимость для `tsc`: 34 тысячи инстанциаций, 0,14 с проверки; ошибки «Type instantiation is excessively deep» нет.

## Версии

| Что | Состояние |
|---|---|
| `tripolskypetr/agent-runtime` на Docker Hub | `b6c6a184…` от 2026-10-29, без этих изменений. Новый образ не собирался и не публиковался |
| `agent-runtime-sdk` | 0.2.0 в рабочем дереве `packages/sdk`, собран (`build/`, `types.d.ts`), в npm не опубликован |
| Сервер | рабочее дерево, собран (`npm run build`), все проверки ниже на нём |
| Модель | `gemma4:31b-cloud` через Ollama cloud, `OLLAMA_THINK=false` |

## Часть 1. Сервер

| Пункт | Состояние |
|---|---|
| 1.1 ajv-валидатор | Сделано. `ajv` ^8.20 и `ajv-formats` явные зависимости. [src/helpers/schema.ts](src/helpers/schema.ts): `Ajv2020` с `strict: false`, `strictSchema: "log"` (предупреждения о неизвестных ключах идут в `debug.log`, scope `schema`), `allErrors`, `allowUnionTypes`; `compileFormat` с кэшем по sha256 содержимого; `$id` и `$schema` отбрасываются перед компиляцией, разрешаются только локальные `#/$defs/...` |
| 1.1 `formatErrors` | Сделано. Путь `/signal/direction` → `signal.direction`, корень → `answer`; к сообщению добавляются `allowedValues`, `allowedValue`, `additionalProperty`, `pattern`; не более 5 строк плюс «…and N more». Ошибки отсортированы от самого глубокого пути: при провале `oneOf` ajv перечисляет претензии всех веток у корня (`missing required property "all"`, `has unexpected property "feature"`), а реальная ошибка обычно самая глубокая (`signal.entry.feature: must be one of [...]`) |
| 1.1 `validateToolArguments` | Делегирует компилированному валидатору, сигнатура и ветка «пустые аргументы» сохранены |
| 1.1 400 `invalid_format` | Сделано в [src/routes/inference.route.ts](src/routes/inference.route.ts): схема компилируется при приёме запроса, ошибка компиляции даёт `{ status: "error", error: { code: "invalid_format", message } }`, запись в базе не создаётся. Код добавлен в Swagger (`InferenceError.code`, схема `InvalidFormat`) |
| 1.1 `type: "object"` сверху | Оставлено |
| 1.2 Схема для модели | Сделано: `toModelSchema` убирает `$schema`, `$id`, `title`, `examples`, `$comment`, `default`, раскрывает `$ref` на `MODEL_SCHEMA_REF_DEPTH` (по умолчанию 3), на срезе оставляет `description` целевого определения или «nested "predicate" of the same shape as above», `$defs` не передаёт. Применяется к параметрам инструмента в запросе к Ollama и к `{{{schema}}}` в промпте. Валидация по исходной схеме |
| 1.2 Эксперимент «как есть» | Проведён, см. ниже. Схема с `$ref` и `$defs` без раскрытия (`MODEL_SCHEMA_REF_DEPTH=0`) на `gemma4:31b-cloud` прошла все 8 случаев, как и раскрытая |
| 1.2 Правила в промпте | Добавлено правило 5 в [assets/system.mustache](assets/system.mustache): `null` это JSON null, не строка; при `oneOf`/`anyOf` ровно одна ветка; `const` копируется дословно; `enum` исчерпывающий; лишние свойства запрещены |
| 1.3 Повторы | Текст валидатора уходит модели как результат инструмента и читаем, примеры ниже. Лог `run start` печатает `required`, `properties`, `defs`, `hasOneOf`, `hasAnyOf`, `hasAllOf`, `hasRef`, `hasIf`, `hasConst`, размер схемы |
| 1.4 Документация | README (раздел API: JSON Schema 2020-12, поддерживаемые ключи, `invalid_format`, схема для модели), описание `FormatModel` в Swagger, `MODEL_SCHEMA_REF_DEPTH` в `config/.env.example` |
| 1.5 Smoke | [demo/smoke-schema.ts](demo/smoke-schema.ts), `npm run smoke:schema`; результаты ниже |

Валидация продублирована на клиент. [packages/sdk/src/validation/validateToolArguments.ts](packages/sdk/src/validation/validateToolArguments.ts) это валидатор без зависимостей в стиле json-inference (те же экспорты `typeOf`, `validateValue`, `validateToolArguments`, та же форма `ValidationResult`), расширенный на ключи 2020-12: `type` строкой или массивом, `enum`/`const` любых JSON-значений, `oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`, локальный `$ref` (JSON pointer в корень), `additionalProperties`/`patternProperties`/`propertyNames`/`dependent*`, `items`/`prefixItems`/`contains`/`uniqueItems`, границы строк, чисел, массивов и объектов. `format` и неизвестные ключи игнорируются, поэтому он никогда не строже ajv. Сервер использует байт-в-байт копию этого файла ([src/validation/validateToolArguments.ts](src/validation/validateToolArguments.ts); `npm run test:schema` падает, если копии разошлись) первым, а ajv вторым барьером. Паритет: на 60 с лишним значениях в `demo/schema.test.ts` оба валидатора согласны. SDK проверяет каждый успешный ответ той же функцией и при несовпадении повторяет инференс (до `maxAttempts`, по умолчанию 3), после чего отдаёт `schema_mismatch` с деталями по каждой попытке; `validateAnswer`/`assertAnswer` экспортированы для проверки ответов из кэша стратегии после смены схемы.

Одна находка, которой в TODO не было. pi-agent-core сам проверяет аргументы любого вызова инструмента против `tool.parameters` (TypeBox, с приведением типов) до `execute`, и его сообщения скупые: `signal.direction: must be equal to constant` без значения, `root: must match "then" schema`, `comment: schema is false`. Пока параметрами инструмента была схема для модели, модель получала именно эти тексты, а ajv до дела не доходил. Поэтому `provide_answer` объявлен для pi с разрешающей схемой `{ type: "object", additionalProperties: true }`, а схема для модели подставляется в запрос к Ollama потоковой функцией (`toolParameters` в [src/agent/ollama.ts](src/agent/ollama.ts)). Валидатор один, ajv, и модель видит его сообщения.

## Часть 2. SDK

| Пункт | Состояние |
|---|---|
| 2.1 Тип схемы | `JsonSchema` с `readonly`-полями: `type` строкой или массивом, `enum`, `const`, `oneOf`, `anyOf`, `allOf`, `not`, `if`/`then`/`else`, `$ref`, `$defs`, `properties`, `required`, `additionalProperties`, `items`, `prefixItems`, `min`/`max` для строк, чисел, массивов и объектов, `pattern`, `format`, `description`, `title`, `$schema`, `$id`, `default`, `examples` и остальные ключи 2020-12. `description` необязателен. `FormatModel` это объект сверху с `required` и `properties`. `FormatItems`/`FormatProperty` оставлены как алиасы |
| 2.2 Вывод типа | `InferProperty<T, Root, Depth>` в порядке `$ref` → `const` → `enum` → `oneOf`/`anyOf` → `allOf` → массив типов → скаляры → массив → объект; `if`/`then`/`else` тип не меняют; `additionalProperties: false` индексной сигнатуры не даёт (её нет ни в каком случае). Глубина по умолчанию 6 |
| 2.3 `typedFormat` | Не реализовано по решению владельца, см. выше |
| 2.4 Тесты | [packages/sdk/test/typecheck.ts](packages/sdk/test/typecheck.ts): по случаю на каждый ключ таблицы 2.2 (`const`, `enum`, `type: [..., "null"]`, `type: "null"`, `oneOf`, `anyOf`, `allOf`, `if`/`then`, `enum` с `null`), `@ts-expect-error` на неверный литерал `const` и на неверную ветку `oneOf`, схема агента 1 целиком, рекурсия на глубине 3. [packages/sdk/test/test.mjs](packages/sdk/test/test.mjs): round trip nullable и `oneOf` против сервера, 400 `invalid_format` как `AgentRuntimeError` с кодом. Оба компилируются и работают против собранного `types.d.ts` и `build/`, `rollup-plugin-dts` выносит рекурсивные типы корректно |
| 2.5 Документация и релиз | README SDK переписан (таблица ключей, глубина `$ref`, одна схема в одном `defineFormat`, пример схемы агента 1), версия 0.2.0. Публикация за владельцем |

Старые схемы json-inference (`satisfies FormatModel`, без `defineFormat`) работают как раньше: `enum` расширяется до `string`, все поля обязательные.

## Результаты smoke (часть 1.5)

`gemma4:31b-cloud`, `OLLAMA_THINK=false`. «Принудительное нарушение» это инструкция модели нарочно ошибиться в первом вызове `provide_answer` и исправиться после ответа валидатора; в скобках текст, который модель получила.

| Случай | `MODEL_SCHEMA_REF_DEPTH=0` (как есть) | `=3` (по умолчанию) |
|---|---|---|
| `type: ["string", "null"]`, в тексте нет времени → `published_at: null` | принято, 1 ход | принято, 1 ход |
| `signal` как `oneOf: [null, object]` плюс `if`/`then` на тексте без прогноза → `null` | принято, 1 ход | принято, 1 ход |
| Нарушение `const` (`direction: "short"`) | отклонено, после повтора принято: `signal.direction: must be exactly "long"; signal: must be null; signal: must match exactly one of the allowed shapes` | то же |
| `additionalProperties: false` с лишним ключом | отклонено, принято: `answer: has unexpected property "comment"` | то же |
| `pattern: "^c[0-9]{1,2}$"` с `claim-1` | отклонено, принято: `ids[0]: must match pattern ^c[0-9]{1,2}$; ids[1]: ...` | то же |
| Рекурсивный предикат `all`/`any`/`not` через `$ref` | принят с первого раза, 4 уровня, проверен по `$defs` | то же |
| `allOf` с `if`/`then`: `summary_only` и непустой `signal` | отклонено, принято: `signal: must be null` | то же |
| `$ref` на несуществующий `$defs` | 400 `invalid_format`, записи в базе нет | то же |
| Синтетическая статья с явным long-прогнозом (`demo/fixtures/agent1.synthetic-c.article.txt`) по схеме агента 1 → `signal` не `null` | принято с первого раза, 1 ход: `forecast_expressible`, 3 claims (`c1` `forward_directional` BTC up, `c2` BTC down, `c3` `advice_generic`), `signal.based_on_claim_ids: ["c1"]`, `entry: last_price gt 84900`, `invalidation: last_price lt 82000`, `hard_stop: price 82000`; пост-валидация без замечаний | то же |

Итого 8/8 в обоих режимах, синтетический случай с непустым `signal` 1/1. Размер параметров инструмента для схемы агента 1: 4,5 КБ как есть против 6,1 КБ с раскрытием до 3 уровней. Раз модель справляется с `$ref` сама, `0` экономит токены на каждом ходу; по умолчанию оставлено 3, потому что локальные модели меньшего размера на `$ref` не проверялись.

Валидатор отдельно, без модели ([demo/schema.test.ts](demo/schema.test.ts), `npm run test:schema`): 36/36. Схемы агентов 1, 2, 3 компилируются; фикстуры A и B проходят схему агента 1; `const`, `oneOf`, `if`/`then` (агент 1 и агент 3), `pattern`, `additionalProperties`, `minLength`, `maxItems`, `exclusiveMinimum`, `enum` с `null` (агент 2), нарушение в листе предиката на третьем уровне отклоняются с путём; невалидный `$ref` даёт `InvalidFormatError`; кэш компиляции; `toModelSchema` на обеих глубинах.

## Схемы AGENT.md без правок

Да, с одной оговоркой, которая уже есть в части 3 TODO: ссылки `predicate.schema.json#/$defs/predicate` внешние, сервер разрешает только локальные. [demo/fixtures](demo/fixtures) содержит результат склейки, сделанной скриптом из AGENT.md: `$defs` предиката вклеены в схему агента 1, ссылки переписаны на `#/$defs/predicate`. Схемы агентов 2 и 3 ссылок не содержат и приняты дословно. `$schema`, `$id`, `title` присутствуют и игнорируются. Никаких других изменений не потребовалось, в том числе для `exclusiveMinimum` числом, `enum` без `type`, `enum` с `null`.

## Фикстуры A и B, синтетическая фикстура C

На уровне валидатора A и B проходят схему агента 1 без замечаний (`npm run test:schema`).

Поскольку в A и B `signal: null`, ветка `oneOf` с объектом сигнала, `const` для `direction`/`asset`, `pattern` в `based_on_claim_ids` и предикаты через `$ref` на golden-данных не задействованы. Для этого добавлена синтетическая фикстура C: статья [demo/fixtures/agent1.synthetic-c.article.txt](demo/fixtures/agent1.synthetic-c.article.txt) в формате сайта с явным направленным утверждением («закрепление выше 84 900 откроет дорогу к 88 000 в течение ближайших суток», отмена «ниже 82 000») и ожидаемый ответ [demo/fixtures/agent1.fixture-c.json](demo/fixtures/agent1.fixture-c.json) с непустым `signal`. Пост-валидация из AGENT.md разделов 3 и 5 вынесена в [demo/agent1.check.ts](demo/agent1.check.ts): цитаты дословно, `based_on_claim_ids` только на `forward_directional`/`up`/`falsifiable`/`expressible` claims, числовые литералы предикатов из текста, глубина ≤ 3 и листьев ≤ 8. Тест проверяет, что C проходит схему и пост-валидацию, а испорченный вариант C (перефразированная цитата, down-claim как основание, выдуманный уровень, глубина 4) схему проходит, но пост-валидация ловит все четыре дефекта. На модели этот случай в таблице smoke выше: `gemma4:31b-cloud` выдала сигнал с теми же уровнями, что в фикстуре, с первого вызова.

На уровне модели прогнать их на исходных текстах не удалось: обзоров 22.10.2026 и 23.10.2026 нет в датасете (он заканчивается 2026-10-02), а на сайте публично доступен только лид, полный текст за платной подпиской. Вместо этого схема агента 1 с системным промптом из AGENT.md прогнана на статьях датасета, см. ниже.

Схема агента 1 (склеенная, [demo/fixtures/agent1.schema.json](demo/fixtures/agent1.schema.json)) с системным промптом агента 1 как `instructions`, текст и картинки записей датасета, `MODEL_SCHEMA_REF_DEPTH=3`:

| Статья | Результат | Ходов | Отклонённых вызовов | Время |
|---|---|---|---|---|
| 07.09.2023 | `summary_only`, 0 claims, `signal: null`, флаг `no_data_snapshot_time` | 1 | 0 | 2,4 с |
| 01.02.2024 | `summary_only`, 0 claims, `signal: null` | 1 | 0 | 2,8 с |
| 01.03.2024 | `forecast_not_expressible`, 2 claims: `c1` `forward_directional` BTC **down** с уровнем $42 000 (`falsifiable`, `expressible_on_target: true`), `c2` `forward_directional` BTC `none` про «период повторного накопления» (`expressible_on_target: false`, причина заполнена); `signal: null`, как требует правило 5 (только long) | 1 | 0 | 3,8 с |
| 01.04.2024 | `summary_only`, 0 claims, `signal: null` | 1 | 0 | 2,5 с |

Те же две первые статьи только текстом, без картинок: тот же результат (`summary_only`, 0 claims, 1 ход). Итого шесть прогонов схемы агента 1 на модели, доля `schema_mismatch` 0/6, ни одного отклонённого вызова `provide_answer`: модель с первого раза выдаёт ответ, проходящий `additionalProperties: false`, `oneOf` для `signal`, `allOf` с `if`/`then`, `pattern` для `id`, nullable-поля и `const`. Примеры деталей ошибок, которые модель не смогла исправить за три попытки, привести нечем: таких случаев не было. Примеры деталей, которые она исправляла с первого повтора, в таблице smoke выше.

Содержательно ответы совпадают с ожиданием AGENT.md раздел 10 (большинство выпусков `summary_only`, сигнал не формируется), но это не golden-проверка: эталонных ответов для этих дат нет.

## TypeScript на предикате

Вывод типа, без явного типа ответа. `InferFormat<typeof Agent1Format>` даёт `verdict` как union из трёх литералов, `signal: null | { direction: "long"; asset: "BTC"; entry: Predicate; ... }`, `published_at: string | null`, `data_asof_note?: string | null`, `kind` и `data_quality_flags[number]` как union, `hard_stop.mode` как union. Предикат типизирован на пять уровней вложенности, глубже `unknown`; на третьем уровне тип взаимно присваиваем с написанным руками.

## Как запускать

```bash
npm run build && npm run test:schema                                  # валидатор и схема для модели, без модели
node --env-file=.env build/index.js                                   # сервер
npm run smoke:schema                                                  # 8 случаев на модели
SMOKE_ARTICLE=../backtest-news-claims/assets/wwwroot.jsonl SMOKE_ARTICLE_COUNT=4 npm run smoke:schema   # плюс агент 1 на статьях
cd packages/sdk && npm test                                           # сборка, типы, round trip против BASE_URL
```

## Что осталось

- Публикация: `npm run publish:x` (образ) и `npm publish` в `packages/sdk` (0.2.0).
- Часть 3 в backtest-news-claims: `npm i agent-runtime-sdk@^0.2 undici`, вынос схем в `schemas/*.json` со склейкой `$defs`, обновление RUNTIME.md. Готовые склеенные схемы лежат в [demo/fixtures](demo/fixtures).
- Решить, оставлять ли `MODEL_SCHEMA_REF_DEPTH=3` или перейти на `0` для облачной модели.
- Пост-валидация харнессом из AGENT.md раздел 5 (цитаты, числа из текста, глубина предиката) остаётся за стратегией, схема её не делает; референсная реализация проверок лежит в [demo/agent1.check.ts](demo/agent1.check.ts).
