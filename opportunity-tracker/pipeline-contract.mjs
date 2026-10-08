import {createHash} from 'node:crypto';

export const PIPELINE_VERSION='listening-v2';
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function problem(message,status=400){const e=new Error(message);e.status=status;throw e;}
export function string(value,max=500,min=1){if(typeof value!=='string'||value.trim().length<min||value.length>max)problem('The stage returned invalid text.');return value.trim();}
export function array(value,max=20,min=0){if(!Array.isArray(value)||value.length<min||value.length>max)problem('The stage returned an invalid number of entries.');return value;}
export function oneOf(value,values){if(!values.includes(value))problem('The stage returned an unsupported value.');return value;}
export const stringSchema=maxLength=>({type:'string',maxLength});
export const arraySchema=(items,maxItems,minItems=0)=>({type:'array',items,maxItems,minItems});
export const objectSchema=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const enumSchema=values=>({type:'string',enum:values});
export function references(values,allowed,max=8,min=1){const ids=array(values,max,min);if(new Set(ids).size!==ids.length||ids.some(id=>!allowed.includes(id)))problem('The stage refers to unknown or duplicate evidence.');return ids;}
