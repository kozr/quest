import {SOCIAL_CAPTION_STYLES} from '../../caption-styles.mjs';

export function CaptionStylePicker({value,onChange,disabled=false}){
 return <fieldset className="caption-style-picker"><legend>Caption style</legend><div>{SOCIAL_CAPTION_STYLES.map(style=><button key={style} type="button" className="caption-style-option" aria-label={`${style==='snapchat'?'Snapchat':'Instagram'} style`} aria-pressed={value===style} disabled={disabled} onClick={()=>onChange(style)}>{style==='snapchat'?'Snapchat':'Instagram'}</button>)}</div></fieldset>;
}
