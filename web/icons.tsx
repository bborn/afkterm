// Inline icons so they render the same on every device (no font glyph fallbacks).
const props={width:22,height:22,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2.2,strokeLinecap:"round" as const,strokeLinejoin:"round" as const,"aria-hidden":true};
export const PlusIcon=()=><svg {...props}><path d="M12 5v14M5 12h14"/></svg>;
export const SendIcon=()=><svg {...props} strokeWidth={2.6}><path d="M12 19V5M6 11l6-6 6 6"/></svg>;
export const BackIcon=()=><svg {...props} width={26} height={26}><path d="M15 5l-7 7 7 7"/></svg>;
export const MoreIcon=()=><svg {...props}><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></svg>;
export const MicIcon=()=><svg {...props}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>;
export const CloseIcon=()=><svg {...props}><path d="M6 6l12 12M18 6L6 18"/></svg>;
export const EditIcon=()=><svg {...props}><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>;
