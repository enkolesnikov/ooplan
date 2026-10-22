# Архитектура и контракт v1

Локальное приложение: React + TypeScript + Vite; Node.js 24 + Express + встроенный node:sqlite. Один процесс API хранит SQLite и исходные PDF в data/. Координаты — неизменяемые единицы страницы PDF (points); floor.metersPerUnit переводит их в метры. Высоты и запасы — метры. UI zoom не входит в расчёты.

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

## API
- GET /api/projects → {id,name,updatedAt}[]
- POST /api/projects тело Project → Project (создание)
- GET /api/projects/:id → Project
- PUT /api/projects/:id тело Project → Project (полная атомарная запись)
- POST /api/pdfs multipart поле file → {id,name} (исходник PDF)
- GET /api/pdfs/:id → PDF
- GET /api/projects/:id/export?format=csv|xlsx|pdf → журнал и ведомости
- GET /api/projects/:id/backup → JSON с project и pdfs:[{id,name,dataBase64}]
- POST /api/restore тело backup → Project
- GET /api/health → {ok:true}

## Владение модулями
Главный агент: scaffold, src/model.ts, src/demo.ts, интеграция, README.
Frontend: src/App.tsx, src/styles.css, src/main.tsx, index.html; не редактировать модель.
Расчёты/QA: src/engine.ts, tests/engine.test.ts; экспортировать calculateCable(project,cable), segmentLength(project,segment), specifications(project), validateProject(project). Результат calculateCable: {complete:boolean,errors:string[],geometry:number|null,routeReserve:number,cableReserve:number,endReserve:number,total:number|null,segments:{id:string,length:number|null}[]}.
Backend: server/**, tests/api.test.ts; импортирует общую модель и engine. Экспорты API и backup внутри backend.

Проверки: node:test через tsx, сборка tsc + vite, HTTP smoke test и браузерная проверка при наличии Playwright. Проект демонстрации помечен как синтетический, не используется как подмена PDF пользователя.
