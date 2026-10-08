import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { purposes } from "@/purposes.mjs";

export function PurposePicker({ open, onOpenChange, selected, firstSetup, onSave }) {
  const [chosen, setChosen] = useState(selected);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="purpose-dialog">
      <DialogHeader><DialogTitle>{firstSetup ? "What do you want to discover?" : "Choose your purposes"}</DialogTitle><DialogDescription>Choose the views you want in your sidebar. You can change these any time.</DialogDescription></DialogHeader>
      <form onSubmit={event => {event.preventDefault(); onSave(purposes.filter(purpose => chosen.includes(purpose.id)).map(purpose => purpose.id));}}>
        <fieldset className="purpose-choices"><legend className="sr-only">Purposes</legend>
          {purposes.map(purpose => <label key={purpose.id} className={`purpose-choice ${chosen.includes(purpose.id) ? "is-chosen" : ""}`}>
            <input type="checkbox" value={purpose.id} checked={chosen.includes(purpose.id)} onChange={event => setChosen(old => event.target.checked ? [...old, purpose.id] : old.filter(id => id !== purpose.id))} />
            <span><strong>{purpose.label}</strong><span>{purpose.description}</span></span>
          </label>)}
        </fieldset>
        <p className="purpose-picker-note">One conversation can appear in several views. Saves, notes and drafts stay together.</p>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{firstSetup ? "Decide later" : "Cancel"}</Button><Button type="submit" disabled={!chosen.length}>{firstSetup ? "Open workspace" : "Save purposes"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
