"""Host metrics on native Windows/macOS; the Linux server keeps its procfs collector."""
import os
import platform
import psutil
from .procfs import ProcView

class Collector:
    def __init__(self, *, disk_paths=None):
        self.cpu_model=platform.processor() or platform.machine()
        self.in_container=False
        self.disk_paths=disk_paths or []
        self.prev_io=self.prev_net=None
        self.proc_cache={}

    def cpu(self):
        t=psutil.cpu_times_percent()
        cores=psutil.cpu_percent(percpu=True)
        load=psutil.getloadavg() if hasattr(psutil,'getloadavg') else (0,0,0)
        return dict(busy=100-t.idle,user=t.user,system=t.system,iowait=getattr(t,'iowait',0),steal=getattr(t,'steal',0),
                    cores=cores,count=len(cores),btime=int(psutil.boot_time()),procs_blocked=0,
                    load1=load[0],load5=load[1],load15=load[2],first=False)

    def memory(self):
        m=psutil.virtual_memory(); s=psutil.swap_memory()
        occupied=m.total-m.free
        cache=min(occupied,getattr(m,'cached',0)+getattr(m,'buffers',0))
        return dict(total=m.total,available=m.available,used=m.total-m.available,occupied=occupied,
                    non_cache=occupied-cache,free=m.free,cache=cache,shmem=getattr(m,'shared',0),
                    swap_used=s.used,swap_total=s.total,swap_free=s.free)

    def pressure(self): return None
    def cgroup(self,now): return None,None
    def disk_usage(self):
        out=[];seen=set()
        for label,path in self.disk_paths:
            try:
                device=os.stat(path).st_dev
                if device in seen: continue
                seen.add(device); d=psutil.disk_usage(path)
                out.append(dict(label=label,path=path,total=d.total,used=d.used,free=d.free,pct=d.percent))
            except OSError: pass
        return out

    def disk_io(self,now):
        d=psutil.disk_io_counters();old=self.prev_io;self.prev_io=(now,d)
        if not d or not old or now<=old[0]:return dict(read=0,write=0,busy=0)
        dt=now-old[0];p=old[1]
        return dict(read=max(0,d.read_bytes-p.read_bytes)/dt,write=max(0,d.write_bytes-p.write_bytes)/dt,
                    busy=min(100,max(0,getattr(d,'busy_time',0)-getattr(p,'busy_time',0))/dt/10))

    def network(self,now):
        n=psutil.net_io_counters();old=self.prev_net;self.prev_net=(now,n)
        rx=tx=0
        if old and now>old[0]:rx=max(0,n.bytes_recv-old[1].bytes_recv)/(now-old[0]);tx=max(0,n.bytes_sent-old[1].bytes_sent)/(now-old[0])
        return dict(rx=rx,tx=tx,ifaces=list(psutil.net_if_stats()),scope='host')

    def processes(self,now,btime):
        me=psutil.Process(); live={}
        def view(proc):
            try:
                key=(proc.pid,proc.create_time());p=self.proc_cache.setdefault(key,proc)
                children=p.children(recursive=True)
                v=ProcView(pid=p.pid,comm=p.name(),state=p.status(),cmd=' '.join(p.cmdline())[:300],rss=p.memory_info().rss,
                    rss_tree=0,cpu=p.cpu_percent(),cpu_tree=0,threads=p.num_threads(),nprocs=len(children)+1,started=p.create_time())
                v.rss_tree=v.rss
                for c in children:
                    try:v.rss_tree+=c.memory_info().rss
                    except psutil.Error:pass
                v.cpu_tree=v.cpu;live[key]=p;return v
            except psutil.Error:return None
        myself=view(me);kids={}
        for p in me.children():
            v=view(p)
            if v:kids[p.pid]=v
        self.proc_cache=live
        if myself:
            myself.rss_tree=myself.rss+sum(v.rss_tree for v in kids.values())
            myself.cpu_tree=myself.cpu+sum(v.cpu_tree for v in kids.values())
        return myself,kids
