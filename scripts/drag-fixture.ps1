param([Parameter(Mandatory=$true)][int]$ParentId,[Parameter(Mandatory=$true)][string]$Tag)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,System.Web.Extensions
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
public class DragFixture : Form {
  [StructLayout(LayoutKind.Sequential)] public struct Point {public int x,y;}
  [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point value);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect value);
  protected override bool ShowWithoutActivation {get {return true;}}
  protected override CreateParams CreateParams {get {var p=base.CreateParams;p.ExStyle|=0x08000000;return p;}}
  readonly Label status=new Label {Text="Drag state: untouched",Location=new System.Drawing.Point(20,20),AutoSize=true};
  readonly Rectangle source=new Rectangle(30,90,50,50), destination=new Rectangle(240,90,70,70);
  readonly Label keyState=new Label {Text="Shortcut: untouched",Location=new System.Drawing.Point(20,50),AutoSize=true};
  readonly Label clickState=new Label {Text="Right click: untouched",Location=new System.Drawing.Point(20,180),AutoSize=true};
  bool held; int moves, allMoves; MouseButtons lastButton;
  DragFixture(string title,int x) {
    Text=title;StartPosition=FormStartPosition.Manual;Location=new System.Drawing.Point(x,400);ClientSize=new Size(360,220);
    Controls.Add(status);Controls.Add(keyState);Controls.Add(clickState);DoubleBuffered=true;KeyPreview=true;
    KeyDown+=delegate(object sender,KeyEventArgs e) {if(e.Control && e.KeyCode==Keys.K) {keyState.Text="Shortcut: accepted";e.Handled=true;}};
    MouseDown+=delegate(object sender,MouseEventArgs e) {if(e.Button==MouseButtons.Right && destination.Contains(e.Location)) clickState.Text="Right click: accepted";};
    MouseDown+=delegate(object sender,MouseEventArgs e) {if(e.Button==MouseButtons.Left && source.Contains(e.Location)) {held=true;moves=0;status.Text="Drag state: held";}};
    MouseMove+=delegate(object sender,MouseEventArgs e) {if(held) {allMoves++;lastButton=e.Button;if(e.Button==MouseButtons.Left) {moves++;status.Text="Drag state: moving";}}};
    MouseUp+=delegate(object sender,MouseEventArgs e) {
      if(held) status.Text=destination.Contains(e.Location) && moves>1 ? "Drag state: accepted" : "Drag state: missed; moves="+moves+" all="+allMoves+" buttons="+lastButton+" at="+e.X+","+e.Y;
      held=false;
    };
    Paint+=delegate(object sender,PaintEventArgs e) {e.Graphics.FillRectangle(Brushes.SteelBlue,source);e.Graphics.DrawRectangle(Pens.DarkGreen,destination);};
  }
  object Describe() {
    Rect bounds;GetWindowRect(Handle,out bounds);
    var start=PointToScreen(new System.Drawing.Point(55,115));var end=PointToScreen(new System.Drawing.Point(275,115));
    return new {hwnd=Handle.ToInt64().ToString(),from_x=start.X-bounds.left,from_y=start.Y-bounds.top,to_x=end.X-bounds.left,to_y=end.Y-bounds.top};
  }
  public static void Run(int parent,string tag) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var foreground=GetForegroundWindow().ToInt64().ToString();Point cursor;GetCursorPos(out cursor);
    using(var a=new DragFixture(tag+" A",200)) using(var b=new DragFixture(tag+" B",720)) {
      a.Show();b.Show();
      Console.WriteLine(new JavaScriptSerializer().Serialize(new {pid=Process.GetCurrentProcess().Id,a=a.Describe(),b=b.Describe(),foreground=foreground,cursor=cursor}));
      using(var timer=new Timer {Interval=500}) {
        timer.Tick+=delegate {try {if(Process.GetProcessById(parent).HasExited) Application.ExitThread();}catch {Application.ExitThread();}};
        timer.Start();Application.Run();
      }
    }
  }
}
'@
[DragFixture]::Run($ParentId,$Tag)
