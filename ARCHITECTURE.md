# Архитектура CablePlan

CablePlan работает в двух режимах: локальном (React + TypeScript + Vite; Node.js 24 + Express + встроенный node:sqlite) и статическом для GitHub Pages (только клиентская сборка). Общая модель проекта, расчёты и интерфейс используются в обоих режимах; различаются хранение данных и доступные экспорты.

## Режимы работы

**Локальный.** Один процесс API хранит SQLite и исходные PDF в `data/`. Координаты — неизменяемые единицы страницы PDF (points); `floor.metersPerUnit` переводит их в метры. Высоты и запасы — метры. UI zoom не входит в расчёты. Доступны серверное хранение, экспорт CSV/XLSX/PDF, резервная копия JSON с исходными PDF и восстановление.

**Статический (GitHub Pages).** Сайт собирается Vite и работает без бэкенда. Наличие API проверяется запросом `GET /api/health`; если он недоступен, включается режим хранения «Браузер». Проекты сохраняются в `localStorage` (ключ `cableplan:projects`), исходные PDF — в IndexedDB (база `cableplan`, хранилище `pdfs`), поэтому лимит 5 МБ не действует и доступны большие чертежи. Этаж ссылается на файл как `idb:<key>`; демонстрационный план хранится как `data:` URL. Экспорт CSV и JSON с PDF выполняется на клиенте, XLSX/PDF-экспорт в статическом режиме недоступен. В локальном режиме используется хранение «Сервер», в статическом — «Браузер».

## Общая модель (src/model.ts)
```ts
interface Point { x:number; y:number }
interface Floor { id:string; name:string; elevation:number|null; metersPerUnit:number|null; pdfId?:string; page:number; width:number; height:number }
interface Equipment { id:string; number:string; name:string; type:string; floorId:string; x:number; y:number; height:number|null; note:string; properties:Record<string,string> }
interface Vertex { id:string; floorId:string; x:number; y:number; height:number|null }
interface Segment { id:string; a:Vertex; b:Vertex; mode:'orthogonal'|'spatial'; reservePercent:number; reserveFixed:number }
interface Route { id:string; number:string; type:string; segments:Segment[]; note:string }
interface Cable { id:string; number:string; name:string; brand:string; purpose:string; fromId:string; toId:string; segmentIds:string[]; reservePercent:number; reserveFixed:number; startReserve:number; endReserve:number; quantity:number; note:string }
interface Project { schemaVersion:1; id:string; name:string; floors:Floor[]; equipment:Equipment[]; routes:Route[]; cables:Cable[]; updatedAt:string }
```

Сегменты связаны совпадающими координатами и этажом с допуском 1e-6; height также совпадает. Кабель содержит упорядоченный список ID сегментов, каждый физический сегмент допускается один раз. Направление сегмента определяется обходом цепочки. Концы кабеля должны совпадать в плане с началом/концом цепочки на соответствующем этаже; вертикальные подводы от высоты оборудования до высоты трассы учитываются отдельно. Межэтажный сегмент разрешён только при совпадающих x,y (общая система координат этажей), учитывает отметки полов. Неизвестные высоты/масштаб и разрывы означают неполный расчёт; итог null.

Формула: G = сумма пространственных длин сегментов + вертикальные подводы концов. Rт = сумма(Lсегмента × %сегмента / 100 + фиксированный запас сегмента). Итог = G + Rт + G × %кабеля / 100 + фиксированный запас кабеля + запас начала + запас конца. Количество кабелей умножает итог только в спецификации. Инфраструктура учитывается однократно. Промежуточные результаты не округляются. Ортогональный сегмент не допускает одновременных изменений x,y; горизонтальное и вертикальное движение — сумма, spatial — гипотенуза.

## Автопрокладка маршрута

`findRoute(project, fromId, toId)` в `src/engine.ts` возвращает `{ segmentIds:string[]; error?:string }`. По начерченным сегментам строится взвешенный граф: узел — вершина трассы, ключ включает `floorId` и координаты x,y (округление до 0,001), высота на связность не влияет, вес ребра — физическая длина сегмента из `segmentLength`. Для каждого устройства ищется ближайший узел на его этаже по расстоянию в плане, после чего алгоритм Дейкстры находит кратчайший по длине путь и восстанавливает порядок сегментов. Если трассы нет, узлы совпали или граф разорван, возвращается ошибка. Найденную цепочку можно скорректировать вручную кликами по сегментам. Автомаршрут вызывается кнопкой «Автомаршрут» и при выборе двух устройств инструментом «Кабель».

## Цепочка и привязка концов

`chainEnds(project, segmentIds)` возвращает `{ start:Vertex; end:Vertex } | null`. Функция проверяет, что выбранные сегменты образуют непрерывную цепочку в прямом или обратном порядке, и определяет её начало и конец с допуском 1e-6 по этажу, x, y и высоте. Эти концы используются расчётом концевых подводов и интерфейсом.

При создании кабеля концы цепочки автоматически привязываются к выбранному оборудованию: если ближайший конец находится не дальше 100 единиц PDF, оборудование переносится в координаты этого конца (и на его этаж), а направление цепочки выбирается по ближайшей паре «устройство — конец». Если концы слишком далеко, кабель не создаётся и выводится предложение соединить трассу с устройствами. Концевые запасы начала и конца задаются отдельно и входят в итог.

## Учебный проект

`demoPlanPdf()` в `src/demo.ts` генерирует синтетический векторный PDF-план (1000 × 700 единиц): наружные стены, коридор, комнаты, дверные проёмы и подписи стандартным шрифтом Helvetica. Файл собирается в браузере без внешних ресурсов и возвращается как data URL `data:application/pdf;base64,…`. `createDemoProject()` использует его как подложку этажей; проект помечен как учебный и не заменяет рабочую документацию.

## API
- GET /api/projects → {id,name,updatedAt}[]
- POST /api/projects тело Project → Project (создание; повтор ID → 409)
- GET /api/projects/:id → Project
- PUT /api/projects/:id тело Project → Project (полная атомарная запись)
- DELETE /api/projects/:id → {ok:true} (удаление проекта и неиспользуемых исходных PDF)
- POST /api/pdfs multipart поле file → {id,name} (исходник PDF)
- GET /api/pdfs/:id → PDF
- GET /api/projects/:id/export?format=csv|xlsx|pdf → журнал и ведомости
- GET /api/projects/:id/backup → JSON с project и pdfs:[{id,name,dataBase64}]
- POST /api/restore тело backup → Project (upsert: существующий проект перезаписывается)
- GET /api/health → {ok:true}

`POST /api/restore` проверяет структуру копии и PDF, требует наличия всех исходников в самой копии, выполняет запись PDF и проекта в одной транзакции. Совпадающий ID PDF с другим содержимым даёт 409; проект с тем же ID не конфликтует, а перезаписывается.

## Валидация

`assertProject` в `server/validation.ts` проверяет структуру и ссылки перед записью: `schemaVersion`, уникальность ID, существование этажей, оборудования и сегментов, корректность чисел и режимов. Дополнительно проверяется уникальность номеров оборудования, трасс и кабелей, а для оборудования — уникальность имён. Инженерная неполнота (неизвестный масштаб, отметка или высота, разрывы цепочки) не блокирует сохранение: `validateProject` показывает замечания, а расчёт помечается как неполный.

## Мобильный интерфейс

При ширине до 1023 px панели становятся off-canvas: «Структура» выезжает слева, «Свойства» открываются снизу как шторка; фон затемняется, закрытие — кнопкой или касанием вне панели. Инструменты плана вынесены в нижнюю панель с крупными кнопками, шапка компактная, для свойств есть плавающая кнопка. На десктопе те же панели показаны постоянно по бокам рабочей области.

## Владение модулями
Главный агент: scaffold, src/model.ts, src/demo.ts, интеграция, README.
Frontend: src/App.tsx, src/styles.css, src/main.tsx, index.html; не редактировать модель.
Расчёты/QA: src/engine.ts, tests/engine.test.ts; экспортировать calculateCable(project,cable), segmentLength(project,segment), specifications(project), validateProject(project). Результат calculateCable: {complete:boolean,errors:string[],geometry:number|null,routeReserve:number,cableReserve:number,endReserve:number,total:number|null,segments:{id:string,length:number|null}[]}.
Backend: server/**, tests/api.test.ts; импортирует общую модель и engine. Экспорты API и backup внутри backend.

Проверки: node:test через tsx, сборка tsc + vite, HTTP smoke test и браузерная проверка при наличии Playwright. Проект демонстрации помечен как синтетический, не используется как подмена PDF пользователя.
