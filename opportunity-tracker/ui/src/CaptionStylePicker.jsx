import {SOCIAL_CAPTION_STYLES} from '../../caption-styles.mjs';

export function CaptionStylePicker({value,onChange,disabled=false}){
 return <fieldset className="caption-style-picker"><legend>Caption style</legend><div>{SOCIAL_CAPTION_STYLES.map(style=><button key={style} type="button" className="caption-style-option" aria-label={`${style==='snapchat'?'Snapchat':'Instagram'} style`} aria-pressed={value===style} disabled={disabled} onClick={()=>onChange(style)}><span className={`caption-style-sample caption-style-${style}`} aria-hidden="true"><span>your caption</span></span><span>{style==='snapchat'?'Snapchat':'Instagram'}</span><small>{style==='snapchat'?'White text · dark bar':'Bold text · dark outline'}</small></button>)}</div></fieldset>;
}
