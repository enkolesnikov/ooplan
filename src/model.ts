export interface Point { x:number; y:number }
export interface Floor { id:string; name:string; elevation:number|null; metersPerUnit:number|null; pdfId?:string; page:number; width:number; height:number }
export interface Equipment { id:string; number:string; name:string; type:string; floorId:string; x:number; y:number; height:number|null; note:string; properties:Record<string,string> }
export interface Vertex { id:string; floorId:string; x:number; y:number; height:number|null }
export interface Segment { id:string; a:Vertex; b:Vertex; mode:'orthogonal'|'spatial'; reservePercent:number; reserveFixed:number }
export interface Route { id:string; number:string; type:string; segments:Segment[]; note:string }
export interface Cable { id:string; number:string; name:string; brand:string; purpose:string; fromId:string; toId:string; segmentIds:string[]; reservePercent:number; reserveFixed:number; startReserve:number; endReserve:number; quantity:number; note:string }
export interface Project { schemaVersion:1; id:string; name:string; floors:Floor[]; equipment:Equipment[]; routes:Route[]; cables:Cable[]; updatedAt:string }
