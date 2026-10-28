using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace FreebuffComputer {
  public static class Overlay {
    const int Wake = 0x8001;
    static readonly ConcurrentQueue<Dictionary<string, object>> Events = new ConcurrentQueue<Dictionary<string, object>>();
    static readonly List<Surface> Surfaces = new List<Surface>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static StreamWriter Output;
    static TcpClient Client;
    static Dictionary<string, object> Current;
    static RectangleF Target;
    static bool Pointer, ReducedMotion, Rebuild;
    static volatile bool Disconnected;
    static float CursorX, CursorY, FromX, FromY, ToX, ToY;
    static DateTime AnimatedAt;
    static bool CursorKnown, Moving, Dragging;
    static double MoveDuration;
    static object PendingAck;
    static int DisplayRevision;
    static IntPtr TargetWindow;
    static RECT TargetWindowBounds;
    static DateTime NextGeometryCheck, ClickedAt, NextParentCheck;
    static string TargetStatus = "none";
    static int ParentPid;
    static IntPtr FirstWindow;
    static string Label = "Freebuff · Ready";
    static Color Accent = Color.FromArgb(59, 130, 246);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; public POINT(int x, int y) { this.x=x; this.y=y; } }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int x, int y) { cx=x; cy=y; } }
    [StructLayout(LayoutKind.Sequential, Pack=1)] struct BLEND { public byte op, flags, alpha, format; }
    delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data);
    delegate bool WindowCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr rect, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(int action, int param, out int value, int flags);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, int message, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("user32.dll", SetLastError=true)] static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screen, ref POINT dest, ref SIZE size, IntPtr source, ref POINT origin, int key, ref BLEND blend, int flags);

    sealed class Surface : NativeWindow, IDisposable {
      public Rectangle Bounds { get; private set; }
      public readonly float Scale;
      public Surface(Rectangle bounds) {
        Bounds = bounds;
        CreateHandle(new CreateParams { Caption="Freebuff Computer activity", X=bounds.X, Y=bounds.Y,
          Width=bounds.Width, Height=bounds.Height, Style=unchecked((int)0x80000000),
          ExStyle=0x080800A8 }); // NOACTIVATE | LAYERED | TRANSPARENT | TOOLWINDOW | TOPMOST
        Scale = Math.Max(1f, GetDpiForWindow(Handle) / 96f);
      }
      protected override void WndProc(ref Message message) {
        if (message.Msg == 0x84) { message.Result = new IntPtr(-1); return; } // HTTRANSPARENT
        if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; } // MA_NOACTIVATE
        if (message.Msg == Wake) { Drain(); return; }
        if (message.Msg == 0x7E || message.Msg == 0x2E0) Rebuild = true; // display/DPI changed
        base.WndProc(ref message);
      }
      public void Dispose() { DestroyHandle(); }
      public void Draw(Graphics g) {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        float s=Scale;
        // Half-pixel alignment gives the two-pixel stroke two opaque raster rows.
        using(var outline=Rounded(new RectangleF(1.5f*s,1.5f*s,Bounds.Width-3*s,Bounds.Height-3*s),10*s))
        using(var pen=new Pen(Accent,2*s)) g.DrawPath(pen,outline);
        // One quiet session label, on the primary monitor; never expose app titles or payloads.
        if(Bounds.Contains(0,0)) {
          using(var font=new Font("Segoe UI",12.5f*s,FontStyle.Regular,GraphicsUnit.Pixel))
          using(var ink=new SolidBrush(Color.FromArgb(250,20,29,44)))
          using(var text=new SolidBrush(Color.FromArgb(244,247,255)))
          using(var dot=new SolidBrush(Current!=null && Text(Current,"phase","")=="error" ? Color.FromArgb(245,171,76) : Accent))
          using(var format=new StringFormat { Alignment=StringAlignment.Near, LineAlignment=StringAlignment.Center, FormatFlags=StringFormatFlags.NoWrap }) {
            float width=Math.Min(Bounds.Width-32*s,g.MeasureString(Label,font).Width+46*s);
            var rect=new RectangleF((Bounds.Width-width)/2,12*s,width,32*s);
            using(var pill=Rounded(rect,16*s)) g.FillPath(ink,pill);
            g.FillEllipse(dot,rect.X+14*s,rect.Y+12.5f*s,7*s,7*s);
            g.DrawString(Label,font,text,new RectangleF(rect.X+30*s,rect.Y,width-38*s,rect.Height),format);
          }
        }
        if(Pointer && Bounds.Contains((int)CursorX,(int)CursorY)) {
          float x=CursorX-Bounds.X,y=CursorY-Bounds.Y;
          if(Dragging) {
            using(var held=new Pen(Accent,2*s)) g.DrawEllipse(held,x-5*s,y-5*s,10*s,10*s);
          }
          double pulse=(DateTime.UtcNow-ClickedAt).TotalMilliseconds/420;
          if(!ReducedMotion && pulse>=0 && pulse<1) {
            float radius=(float)(5+9*pulse)*s;
            using(var pen=new Pen(Color.FromArgb((int)(170*(1-pulse)),Accent),1.5f*s))
              g.DrawEllipse(pen,x-radius,y-radius,2*radius,2*radius);
          }
          using(var cursor=new GraphicsPath()) {
            // Small rounded arrowhead: its top-left tip is the action point.
            cursor.AddBezier(x,y,x+0.8f*s,y-0.5f*s,x+1.5f*s,y-0.4f*s,x+2.5f*s,y);
            cursor.AddLine(x+2.5f*s,y,x+16*s,y+5.2f*s);
            cursor.AddBezier(x+16*s,y+5.2f*s,x+18*s,y+6*s,x+17.5f*s,y+7.4f*s,x+15.8f*s,y+8*s);
            cursor.AddLine(x+15.8f*s,y+8*s,x+9.7f*s,y+10*s);
            cursor.AddLine(x+9.7f*s,y+10*s,x+7.4f*s,y+16.5f*s);
            cursor.AddBezier(x+7.4f*s,y+16.5f*s,x+6.8f*s,y+18.2f*s,x+5.1f*s,y+18*s,x+4.5f*s,y+16*s);
            cursor.AddLine(x+4.5f*s,y+16*s,x,y+2.3f*s);
            cursor.AddBezier(x,y+2.3f*s,x-0.5f*s,y+1.3f*s,x-0.5f*s,y+0.6f*s,x,y);
            cursor.CloseFigure();
            for(int i=3;i>=1;i--) {
              var saved=g.Save(); g.TranslateTransform(0,1.5f*s);
              using(var shadow=new Pen(Color.FromArgb(12,0,0,0),(2+i)*s) { LineJoin=LineJoin.Round }) g.DrawPath(shadow,cursor);
              g.Restore(saved);
            }
            using(var fill=new SolidBrush(Color.FromArgb(26,29,34))) g.FillPath(fill,cursor);
            using(var edge=new Pen(Color.FromArgb(250,250,252),1.7f*s) { LineJoin=LineJoin.Round }) g.DrawPath(edge,cursor);
          }
        }
      }
      public void Paint() {
        using (var bitmap = new Bitmap(Bounds.Width, Bounds.Height, PixelFormat.Format32bppPArgb)) {
          using (var g = Graphics.FromImage(bitmap)) {
            g.Clear(Color.Transparent);
            Draw(g);
          }
          IntPtr screen=GetDC(IntPtr.Zero), memory=CreateCompatibleDC(screen), handle=bitmap.GetHbitmap(Color.FromArgb(0));
          IntPtr old=SelectObject(memory,handle);
          try {
            var dest=new POINT(Bounds.X,Bounds.Y); var size=new SIZE(Bounds.Width,Bounds.Height); var origin=new POINT(0,0);
            var blend=new BLEND { op=0, flags=0, alpha=255, format=1 };
            if (!UpdateLayeredWindow(Handle,screen,ref dest,ref size,memory,ref origin,0,ref blend,2))
              throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            ShowWindow(Handle,4); // SW_SHOWNOACTIVATE
          } finally { SelectObject(memory,old); DeleteObject(handle); DeleteDC(memory); ReleaseDC(IntPtr.Zero,screen); }
        }
      }
    }

    static GraphicsPath Rounded(RectangleF rect,float radius) {
      var path=new GraphicsPath(); float d=radius*2;
      path.AddArc(rect.X,rect.Y,d,d,180,90); path.AddArc(rect.Right-d,rect.Y,d,d,270,90);
      path.AddArc(rect.Right-d,rect.Bottom-d,d,d,0,90); path.AddArc(rect.X,rect.Bottom-d,d,d,90,90);
      path.CloseFigure(); return path;
    }

    // Uses the same drawing code as the live windows, on a neutral preview canvas.
    public static void SavePreview(string path) {
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      using(var surface=new Surface(new Rectangle(0,0,1280,720)))
      using(var bitmap=new Bitmap(1280,720,PixelFormat.Format32bppPArgb)) {
        using(var g=Graphics.FromImage(bitmap)) {
          g.Clear(Color.FromArgb(243,245,248));
          Label="Freebuff · Click sent"; Pointer=true; CursorX=660; CursorY=350;
          surface.Draw(g);
        }
        bitmap.Save(path,ImageFormat.Png);
      }
    }

    static void BuildSurfaces() {
      foreach (var window in Surfaces) window.Dispose();
      Surfaces.Clear();
      EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr m,IntPtr dc,ref RECT r,IntPtr d) {
        Surfaces.Add(new Surface(Rectangle.FromLTRB(r.left,r.top,r.right,r.bottom))); return true;
      },IntPtr.Zero);
      if (Surfaces.Count == 0) throw new InvalidOperationException("No desktop monitors available");
      FirstWindow=Surfaces[0].Handle;
      Rebuild=false;
      DisplayRevision++;
    }
    static List<object> DescribeSurfaces() {
      var windows=new List<object>();
      foreach(var surface in Surfaces) windows.Add(new { hwnd=surface.Handle.ToInt64().ToString(), x=surface.Bounds.X, y=surface.Bounds.Y, width=surface.Bounds.Width, height=surface.Bounds.Height, scale=surface.Scale });
      return windows;
    }
    static string Text(Dictionary<string,object> data,string key,string fallback) { object value; return data.TryGetValue(key,out value) ? Convert.ToString(value) : fallback; }
    static float Number(Dictionary<string,object> data,string key) { return Convert.ToSingle(data[key],System.Globalization.CultureInfo.InvariantCulture); }

    static void EnsureCursor() {
      bool onScreen=false;
      foreach(var surface in Surfaces) if(surface.Bounds.Contains((int)CursorX,(int)CursorY)) onScreen=true;
      if(!CursorKnown || !onScreen) {
        var primary=Surfaces.Find(surface=>surface.Bounds.Contains(0,0)) ?? Surfaces[0];
        CursorX=primary.Bounds.X+primary.Bounds.Width/2f;
        CursorY=primary.Bounds.Y+primary.Bounds.Height/2f;
      }
      CursorKnown=true; Pointer=true;
    }

    static bool ResolveTarget(Dictionary<string,object> next, out RectangleF rect) {
      rect=RectangleF.Empty; TargetWindow=IntPtr.Zero; TargetStatus="unavailable";
      object raw;
      if(!next.TryGetValue("rect",out raw) || !(raw is Dictionary<string,object>)) return false;
      var frame=(Dictionary<string,object>)raw;
      rect=new RectangleF(Number(frame,"x"),Number(frame,"y"),Number(frame,"width"),Number(frame,"height"));
      if(rect.Width<=0 || rect.Height<=0) return false;
      if(Text(next,"coordinateSpace","")=="desktop") { TargetStatus="desktop"; return true; }
      if(!next.TryGetValue("window",out raw) || !(raw is Dictionary<string,object>)) return false;
      var identity=(Dictionary<string,object>)raw;
      uint wanted=Convert.ToUInt32(identity["pid"]);
      string wantedTitle=Text(identity,"title","");
      var matches=new List<IntPtr>();
      EnumWindows(delegate(IntPtr handle,IntPtr unused) {
        if(identity.ContainsKey("hwnd") && handle.ToInt64().ToString()!=Text(identity,"hwnd","")) return true;
        uint pid; GetWindowThreadProcessId(handle,out pid);
        if(pid!=wanted || !IsWindowVisible(handle) || IsIconic(handle)) return true;
        var title=new StringBuilder(4096); GetWindowText(handle,title,title.Capacity);
        RECT bounds;
        if(title.ToString()==wantedTitle && GetWindowRect(handle,out bounds) &&
           Math.Abs(bounds.right-bounds.left-Number(identity,"width"))<=1 &&
           Math.Abs(bounds.bottom-bounds.top-Number(identity,"height"))<=1) matches.Add(handle);
        return true;
      },IntPtr.Zero);
      // Never choose the first of several windows, or scale an out-of-date snapshot.
      if(matches.Count!=1) return false;
      RECT origin;
      if(!GetWindowRect(matches[0],out origin)) return false;
      rect.Offset(origin.left,origin.top);
      int x=(int)(rect.X+rect.Width/2),y=(int)(rect.Y+rect.Height/2);
      if(x<origin.left || x>=origin.right || y<origin.top || y>=origin.bottom) return false;
      if(GetAncestor(WindowFromPoint(new POINT(x,y)),2)!=matches[0]) { TargetStatus="occluded"; return false; }
      TargetWindow=matches[0]; TargetWindowBounds=origin; TargetStatus="window";
      return true;
    }

    static void Drain() {
      if (Disconnected) { Application.ExitThread(); return; }
      Dictionary<string,object> next;
      while (Events.TryDequeue(out next)) {
        // An error or session close can interrupt an in-flight drag animation.
        if(PendingAck!=null) { Acknowledge(PendingAck); PendingAck=null; }
        bool dragReady=Current!=null && Text(Current,"tool","")=="drag" &&
          (TargetStatus=="window" || TargetStatus=="desktop");
        Current=next;
        string phase=Text(next,"phase","begin"), tool=Text(next,"tool","activity");
        if(tool=="computer_session" && phase=="end") {
          foreach(var surface in Surfaces) ShowWindow(surface.Handle,0);
          Current=null; Dragging=false; Pointer=false; CursorKnown=false; Moving=false; TargetWindow=IntPtr.Zero; TargetStatus="none";
          if(PendingAck!=null) { Acknowledge(PendingAck); PendingAck=null; }
          Acknowledge(next["seq"]); continue;
        }
        EnsureCursor();
        Label="Freebuff · "+Text(next,"label","Session active");
        bool aimed=false;
        if(phase=="begin" || phase=="dispatch") {
          Dragging=false; Moving=false; TargetWindow=IntPtr.Zero; TargetStatus="idle"; ClickedAt=DateTime.MinValue;
          if(next.ContainsKey("pointer") && Convert.ToBoolean(next["pointer"])) {
            bool destinationValid=phase!="dispatch" || dragReady;
            if(tool=="drag" && phase=="begin" && next.ContainsKey("dragTo")) {
              var destination=new Dictionary<string,object>(next);
              destination["rect"]=next["dragTo"];
              RectangleF unused;
              destinationValid=ResolveTarget(destination,out unused);
            }
            if(destinationValid) aimed=ResolveTarget(next,out Target);
          }
          Dragging=tool=="drag" && phase=="dispatch" && aimed;
          if(TargetStatus=="occluded") Label+=" · Background window";
        }
        if(phase=="error") { Dragging=false; Moving=false; TargetWindow=IntPtr.Zero; TargetStatus="idle"; ClickedAt=DateTime.MinValue; }
        if(phase=="end") {
          Dragging=false;
          if(tool=="click" && (TargetStatus=="window" || TargetStatus=="desktop")) ClickedAt=DateTime.UtcNow;
          TargetWindow=IntPtr.Zero; TargetStatus="idle";
        }
        if (aimed) {
          Pointer=true;
          {
            FromX=CursorX; FromY=CursorY; ToX=Target.X+Target.Width/2; ToY=Target.Y+Target.Height/2;
            if (!CursorKnown || ReducedMotion) { FromX=ToX; FromY=ToY; }
            CursorX=FromX; CursorY=FromY; CursorKnown=true; AnimatedAt=DateTime.UtcNow;
            double distance=Math.Sqrt(Math.Pow(ToX-FromX,2)+Math.Pow(ToY-FromY,2));
            MoveDuration=Math.Min(550,240+distance*0.22); Moving=distance>0.5;
          }
        }
        foreach(var surface in Surfaces) surface.Paint();
        // The driver waits until the pointer arrives, not just until its old position paints.
        if(aimed && Moving) PendingAck=next["seq"];
        else Acknowledge(next["seq"]);
      }
    }

    static void Acknowledge(object sequence) {
      Output.WriteLine(Json.Serialize(new { painted=sequence, rendered=new { label=Label, targetStatus=TargetStatus,
        dragging=Dragging, pointer=Pointer ? new { x=CursorX, y=CursorY } : null } }));
    }

    // A helper whose server is gone must not keep painting. The socket already
    // signals EOF on a clean disconnect; this covers a wedged socket and a
    // server killed without closing its end.
    static bool ParentGone() {
      if (ParentPid <= 0) return false;
      try {
        var parent = System.Diagnostics.Process.GetProcessById(ParentPid);
        return parent.HasExited;
      } catch (ArgumentException) { return true; }
      catch (InvalidOperationException) { return true; }
    }

    public static void Run(int port,string token,int parentPid) {
      ParentPid = parentPid;
      // Native window and frame coordinates are physical desktop pixels, even
      // when monitors have different scaling or negative origins.
      SetProcessDpiAwarenessContext(new IntPtr(-4));
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
      int animation;
      ReducedMotion=Environment.GetEnvironmentVariable("FBC_REDUCED_MOTION")=="1" ||
        (SystemParametersInfo(0x1042,0,out animation,0) && animation==0);
      BuildSurfaces();
      Client=new TcpClient();
      Client.Connect("127.0.0.1",port);
      Output=new StreamWriter(Client.GetStream(),new System.Text.UTF8Encoding(false)) { AutoFlush=true };
      Output.WriteLine(Json.Serialize(new { token=token, windows=DescribeSurfaces(), displayRevision=DisplayRevision, reducedMotion=ReducedMotion }));
      var receiver=new Thread(delegate() {
        try {
          using(var input=new StreamReader(Client.GetStream())) {
            string line;
            while((line=input.ReadLine())!=null) {
              if(line.Length>16384) break;
              Events.Enqueue(Json.Deserialize<Dictionary<string,object>>(line));
              PostMessage(FirstWindow,Wake,IntPtr.Zero,IntPtr.Zero);
            }
          }
        } catch(IOException) { } catch(ObjectDisposedException) { }
        finally { Disconnected=true; PostMessage(FirstWindow,Wake,IntPtr.Zero,IntPtr.Zero); }
      });
      receiver.IsBackground=true;
      receiver.Start();
      using(var timer=new System.Windows.Forms.Timer { Interval=16 }) {
        timer.Tick+=delegate {
          // A wake posted while monitor windows are being replaced may target
          // a destroyed handle. The timer also drains the queue and checks EOF.
          if (DateTime.UtcNow >= NextParentCheck) {
            NextParentCheck = DateTime.UtcNow.AddSeconds(2);
            if (ParentGone()) Disconnected = true;
          }
          if(Disconnected) { Application.ExitThread(); return; }
          if(Rebuild) {
            BuildSurfaces();
            Dragging=false; Moving=false; TargetWindow=IntPtr.Zero; TargetStatus="idle";
            if(Current!=null) EnsureCursor();
            if(PendingAck!=null) { Acknowledge(PendingAck); PendingAck=null; }
            if(Current!=null) foreach(var surface in Surfaces) surface.Paint();
            Output.WriteLine(Json.Serialize(new { windows=DescribeSurfaces(), displayRevision=DisplayRevision }));
          }
          Drain();
          if(Current==null) return;
          bool repaint=false;
          if(Pointer && TargetWindow!=IntPtr.Zero && DateTime.UtcNow>=NextGeometryCheck) {
            NextGeometryCheck=DateTime.UtcNow.AddMilliseconds(100);
            RECT bounds;
            if(!IsWindowVisible(TargetWindow) || IsIconic(TargetWindow) || !GetWindowRect(TargetWindow,out bounds) ||
               bounds.left!=TargetWindowBounds.left || bounds.top!=TargetWindowBounds.top ||
               bounds.right!=TargetWindowBounds.right || bounds.bottom!=TargetWindowBounds.bottom ||
               GetAncestor(WindowFromPoint(new POINT((int)ToX,(int)ToY)),2)!=TargetWindow) {
              // Keep the session cursor where it is, but withdraw the stale target.
              Dragging=false; Moving=false; TargetWindow=IntPtr.Zero; TargetStatus="unavailable"; ClickedAt=DateTime.MinValue; repaint=true;
              if(PendingAck!=null) { Acknowledge(PendingAck); PendingAck=null; }
            }
          }
          if(Pointer && (DateTime.UtcNow-ClickedAt).TotalMilliseconds<460) repaint=true;
          if(Moving) {
            double p=Math.Min(1,(DateTime.UtcNow-AnimatedAt).TotalMilliseconds/MoveDuration), eased=1-Math.Pow(1-p,3);
            CursorX=FromX+(ToX-FromX)*(float)eased; CursorY=FromY+(ToY-FromY)*(float)eased;
            foreach(var surface in Surfaces) surface.Paint();
            if(p>=1) { Moving=false; if(PendingAck!=null) { Acknowledge(PendingAck); PendingAck=null; } }
          } else if(repaint) foreach(var surface in Surfaces) surface.Paint();
        };
        timer.Start();
        try { Application.Run(); }
        finally { timer.Stop(); Client.Close(); foreach(var surface in Surfaces) surface.Dispose(); }
      }
    }
  }
}
