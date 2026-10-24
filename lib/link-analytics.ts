"use client"

import { collection, doc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, startAfter, Timestamp, where, writeBatch, type QueryDocumentSnapshot } from "firebase/firestore"
import { db } from "@/lib/firebase"
export type ProductLinkSource = "share-ping" | "mate-invite"
export type ProductLinkEventKind = "created" | "opened" | "answered" | "used"
export interface ProductLinkEvent { id:string; source:ProductLinkSource; linkId:string; kind:ProductLinkEventKind; ownerUid:string; fromName:string; recipientName:string; createdAt:{toDate?:()=>Date}|Date|null }
type NewEvent = Omit<ProductLinkEvent,"id"|"createdAt">
const safeId = (v:string) => v.replace(/[^a-zA-Z0-9_-]/g,"").slice(0,128)
const randomHex=()=>{if(typeof crypto==="undefined"||typeof crypto.getRandomValues!=="function")return"";const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("")}
/** Best-effort minimal product analytics: no class detail, email, IP, location, or browser/device fingerprints. */
export async function recordProductLinkEvent(e:NewEvent):Promise<boolean>{
 if(!["share-ping","mate-invite"].includes(e.source)||!["created","opened","answered","used"].includes(e.kind))return false
 if(!e.linkId||e.linkId.length>128||!e.ownerUid||e.ownerUid.length>128||e.fromName.length>40||e.recipientName.length>40)return false
 const prefix=e.source==="share-ping"?"sp":"mi",rnd=e.kind==="opened"?randomHex():""
 if(e.kind==="opened"&&!rnd)return false
 const id=e.kind==="opened"?`${prefix}-open-${rnd}`:`${prefix}-${e.kind}-${safeId(e.linkId)}`
 try{await setDoc(doc(db,"productLinkEvents",id),{source:e.source,linkId:e.linkId,kind:e.kind,ownerUid:e.ownerUid,fromName:e.fromName,recipientName:e.recipientName,createdAt:serverTimestamp()});return true}catch{return false}
}
const dateVal=(v:unknown):ProductLinkEvent["createdAt"]=>{if(v instanceof Date)return v;if(v&&typeof v==="object"&&"toDate"in v&&typeof v.toDate==="function")return v as {toDate:()=>Date};return null}
/** The most events the dashboard loads in one go (read in pages of LINK_PAGE). Past this the oldest are left out and the page says so. */
export const LINK_EVENT_LIMIT = 20000
const LINK_PAGE = 2000
export async function getDeveloperProductLinkEvents():Promise<{events:ProductLinkEvent[];truncated:boolean}>{
 const cutoff=Timestamp.fromMillis(Date.now()-90*24*60*60*1000)
 for(let i=0;i<20;i++){const old=await getDocs(query(collection(db,"productLinkEvents"),where("createdAt","<",cutoff),orderBy("createdAt","asc"),limit(400)));if(old.empty)break;const batch=writeBatch(db);old.docs.forEach(row=>batch.delete(row.ref));await batch.commit();if(old.size<400)break}
 const docs:QueryDocumentSnapshot[]=[];let truncated=false;let last:QueryDocumentSnapshot|undefined
 while(docs.length<LINK_EVENT_LIMIT){
  const page=await getDocs(last?query(collection(db,"productLinkEvents"),orderBy("createdAt","desc"),startAfter(last),limit(LINK_PAGE)):query(collection(db,"productLinkEvents"),orderBy("createdAt","desc"),limit(LINK_PAGE)))
  docs.push(...page.docs)
  if(page.size<LINK_PAGE)break
  last=page.docs[page.size-1]
  if(docs.length>=LINK_EVENT_LIMIT)truncated=true
 }
 const events=docs.map(row=>{const d=row.data();return{id:row.id,source:d.source as ProductLinkSource,linkId:String(d.linkId??""),kind:d.kind as ProductLinkEventKind,ownerUid:String(d.ownerUid??""),fromName:String(d.fromName??"Unknown"),recipientName:String(d.recipientName??""),createdAt:dateVal(d.createdAt)}}).filter(e=>["share-ping","mate-invite"].includes(e.source)&&["created","opened","answered","used"].includes(e.kind)&&!!e.linkId)
 return{events,truncated}
}
