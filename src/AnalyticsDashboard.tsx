import { useMemo, useState } from 'react';
import { BarChart3, Download, Image, PencilLine } from 'lucide-react';
import { summarizePhotoSessions } from './engine/sessionAnalytics.mjs';
import type { CountSession } from './types/counting';

type Props = { sessions: CountSession[]; onOpenSession: (session: CountSession) => void };
const cardStyle: React.CSSProperties = { background:'#fff', border:'1px solid #dfe7e2', borderRadius:14, padding:16, minWidth:0 };
const muted: React.CSSProperties = { color:'#72817c', fontSize:11 };

export function AnalyticsDashboard({ sessions, onOpenSession }: Props) {
  const [period, setPeriod] = useState<'7'|'30'|'all'>('7');
  const summary = useMemo(() => summarizePhotoSessions(sessions, { now:Date.now(), days:period === 'all' ? 0 : Number(period) }), [sessions, period]);
  const maxDaily = Math.max(1, ...summary.dailyTrend.map(day => day.detections));
  const maxCategory = Math.max(1, ...summary.categories.map(item => item.count));
  function exportReport() {
    const rows = [['report','CountAI photo analytics'],['period',period === 'all' ? 'All time' : 'Last ' + period + ' days'],
      ['photo sessions',summary.totalSessions],['detections',summary.totalDetections],['manual corrections',summary.manualCorrections],
      ['average detections per session',summary.averageDetections],[],['date','sessions','detections'],
      ...summary.dailyTrend.map(day => [day.date,day.sessions,day.detections]),[],['category','detections'],
      ...summary.categories.map(item => [item.category,item.count])];
    const csv = rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"','""') + '"').join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const anchor = document.createElement('a'); anchor.href=url; anchor.download='countai-photo-analytics.csv'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  return <section className="history-section" aria-labelledby="analytics-title">
    <div className="section-heading"><div><span className="step">04 / INSIGHTS</span><h2 id="analytics-title">Photo analytics</h2></div>
      <button className="outline-button" onClick={exportReport} disabled={!summary.totalSessions}><Download size={15}/> Export report</button></div>
    <p style={{...muted,lineHeight:1.7,marginTop:-8}}>A private, on-device summary of saved photo-counting sessions. Live-camera crossings are not included in this report.</p>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',margin:'14px 0 18px'}} role="group" aria-label="Analytics time period">
      {([{value:'7',label:'7 days'},{value:'30',label:'30 days'},{value:'all',label:'All time'}] as const).map(option =>
        <button key={option.value} className={period===option.value?'primary-button':'outline-button'} aria-pressed={period===option.value} onClick={()=>setPeriod(option.value)}>{option.label}</button>)}
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(135px,1fr))',gap:10}}>
      <div style={{...cardStyle,background:'#eaf6f1'}}><span style={muted}>PHOTO SESSIONS</span><strong style={{display:'block',fontSize:29,marginTop:7}}>{summary.totalSessions}</strong><span style={muted}>Saved analyses</span></div>
      <div style={cardStyle}><span style={muted}>DETECTIONS</span><strong style={{display:'block',fontSize:29,marginTop:7}}>{summary.totalDetections}</strong><span style={muted}>AI + manual entries</span></div>
      <div style={cardStyle}><span style={muted}>MANUAL CORRECTIONS</span><strong style={{display:'block',fontSize:29,marginTop:7}}>{summary.manualCorrections}</strong><span style={muted}>Edited or added labels</span></div>
      <div style={cardStyle}><span style={muted}>AVG. DETECTIONS</span><strong style={{display:'block',fontSize:29,marginTop:7}}>{summary.averageDetections}</strong><span style={muted}>Per photo session</span></div>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))',gap:12,marginTop:12}}>
      <div style={cardStyle}><h3 style={{fontSize:13,margin:'0 0 15px'}}><BarChart3 size={15} style={{verticalAlign:'middle',marginRight:6}}/>Daily activity</h3>
        {summary.dailyTrend.some(day=>day.detections>0)?<div style={{display:'flex',alignItems:'end',gap:5,minHeight:145}}>
          {summary.dailyTrend.map(day=><div key={day.date} title={day.date+': '+day.detections+' detections across '+day.sessions+' sessions'} style={{flex:1,minWidth:0,textAlign:'center'}}>
            <div style={{height:112,display:'flex',alignItems:'end',justifyContent:'center'}}><div style={{width:'72%',minWidth:4,height:(day.detections?Math.max(4,day.detections/maxDaily*100):0)+'%',background:'#42b99b',borderRadius:'5px 5px 0 0'}}/></div>
            <small style={{...muted,display:'block',fontSize:9,marginTop:7}}>{day.date.slice(5)}</small></div>)}
        </div>:<p style={muted}>No photo sessions in this period yet.</p>}</div>
      <div style={cardStyle}><h3 style={{fontSize:13,margin:'0 0 15px'}}>Category mix</h3>
        {summary.categories.length?summary.categories.slice(0,8).map(item=><div key={item.category} style={{marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:8,fontSize:11,marginBottom:5}}><span>{item.category}</span><b>{item.count}</b></div>
          <div style={{height:6,background:'#edf1ee',borderRadius:8,overflow:'hidden'}}><div style={{width:(item.count/maxCategory*100)+'%',height:'100%',background:'#42b99b'}}/></div></div>)
          :<p style={muted}>Category data appears after photo analyses are saved.</p>}</div>
    </div>
    <div style={{...cardStyle,marginTop:12}}><h3 style={{fontSize:13,margin:'0 0 12px'}}><Image size={15} style={{verticalAlign:'middle',marginRight:6}}/>Recent photo sessions</h3>
      {summary.recentSessions.length?summary.recentSessions.map(session=><div key={session.id} style={{display:'flex',alignItems:'center',gap:12,padding:'11px 0',borderBottom:'1px solid #edf1ee'}}>
        <div style={{flex:1,minWidth:0}}><b style={{display:'block',fontSize:12,overflowWrap:'anywhere'}}>{session.title}</b><small style={muted}>{new Date(session.createdAt).toLocaleString()} · {session.detections.length} detections</small></div>
        <button className="outline-button" onClick={()=>onOpenSession(session)}><PencilLine size={14}/> Review</button></div>)
        :<p style={muted}>No saved photo sessions to report yet. Analyze a photo to start building your history.</p>}</div>
  </section>;
}
