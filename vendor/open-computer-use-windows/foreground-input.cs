using System;
using System.Runtime.InteropServices;
using System.Threading;

// Used only when the human starts the bundled driver with foreground input enabled.
public static class ForegroundInput {
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Key { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct Payload { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Key key; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Payload value; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; public Point(int a,int b){x=a;y=b;} }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  static void Send(Input input) {
    if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1)
      throw new InvalidOperationException("Windows refused foreground input (possibly an elevated target).");
  }
  static void MouseEvent(uint flags,int x=0,int y=0) {
    Send(new Input {type=0,value=new Payload {mouse=new Mouse {x=x,y=y,flags=flags}}});
  }
  static void KeyEvent(ushort vk,bool up) {
    uint flags=up?2u:0u;
    if((vk>=0x21 && vk<=0x2E) || vk==0x5B) flags|=1;
    Send(new Input {type=1,value=new Payload {key=new Key {vk=vk,flags=flags}}});
  }
  static void CheckFocus(IntPtr hwnd) {
    if(GetForegroundWindow()!=hwnd) throw new InvalidOperationException("Foreground window changed; input stopped.");
  }
  static void Prepare(IntPtr hwnd) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    foreach(int key in new[]{1,2,4,16,17,18,91,92})
      if(GetAsyncKeyState(key)<0) throw new InvalidOperationException("Release held mouse buttons and modifier keys before foreground input.");
    if(GetForegroundWindow()!=hwnd) {SetForegroundWindow(hwnd);Thread.Sleep(80);}
    if(GetForegroundWindow()!=hwnd) throw new InvalidOperationException("Windows denied foreground activation. Bring the requested window to the foreground, then retry.");
  }
  static void CheckPoint(IntPtr hwnd,int x,int y,Rect original) {
    CheckFocus(hwnd);
    Rect current;
    if(!GetWindowRect(hwnd,out current) || current.left!=original.left || current.top!=original.top ||
       current.right!=original.right || current.bottom!=original.bottom ||
       x<current.left || x>=current.right || y<current.top || y>=current.bottom ||
       GetAncestor(WindowFromPoint(new Point(x,y)),2)!=hwnd)
      throw new InvalidOperationException("Foreground target moved or is occluded; input stopped.");
  }
  static void Move(int x,int y) {
    int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
    if(width<2 || height<2) throw new InvalidOperationException("Desktop geometry unavailable.");
    MouseEvent(0xC001,(int)Math.Round((x-left)*65535.0/(width-1)),(int)Math.Round((y-top)*65535.0/(height-1)));
  }
  public static void Drag(IntPtr hwnd,int x,int y,int endX,int endY) {
    Prepare(hwnd);
    Rect rect;if(!GetWindowRect(hwnd,out rect)) throw new InvalidOperationException("Window unavailable.");
    CheckPoint(hwnd,x,y,rect);CheckPoint(hwnd,endX,endY,rect);
    Move(x,y);bool held=false;
    try {
      CheckPoint(hwnd,x,y,rect);MouseEvent(2);held=true;
      for(int i=1;i<=12;i++) {
        int px=(int)Math.Round(x+(endX-x)*i/12.0),py=(int)Math.Round(y+(endY-y)*i/12.0);
        CheckPoint(hwnd,px,py,rect);Move(px,py);Thread.Sleep(20);
      }
    } finally {if(held) MouseEvent(4);}
  }
  public static void Click(IntPtr hwnd,int x,int y,string button,int count) {
    Prepare(hwnd);
    Rect rect;if(!GetWindowRect(hwnd,out rect)) throw new InvalidOperationException("Window unavailable.");
    uint down=button=="right"?8u:button=="middle"?32u:2u,up=down*2;
    CheckPoint(hwnd,x,y,rect);Move(x,y);
    for(int i=0;i<count;i++) {
      CheckPoint(hwnd,x,y,rect);bool held=false;
      try {MouseEvent(down);held=true;Thread.Sleep(35);} finally {if(held) MouseEvent(up);}
      Thread.Sleep(50);
    }
  }
  public static void PressKey(IntPtr hwnd,int[] keys) {
    Prepare(hwnd);int pressed=0;
    try {
      foreach(int key in keys) {CheckFocus(hwnd);KeyEvent((ushort)key,false);pressed++;}
      Thread.Sleep(25);
    } finally {
      // Always release only the keys this operation pressed, even after focus loss.
      Exception releaseError=null;
      for(int i=pressed-1;i>=0;i--) {
        try {KeyEvent((ushort)keys[i],true);} catch(Exception error) {releaseError=error;}
      }
      if(releaseError!=null) throw releaseError;
    }
  }
}
