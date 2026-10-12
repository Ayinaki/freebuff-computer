param([Parameter(Mandatory=$true)][int]$ParentId,[Parameter(Mandatory=$true)][string]$Tag)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Web.Extensions,System.Xaml
$refs=@([System.Xaml.XamlReader].Assembly.Location,[System.Windows.Window].Assembly.Location,[System.Windows.Media.Visual].Assembly.Location,[System.Windows.Threading.Dispatcher].Assembly.Location,[System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Automation;
using System.Windows.Interop;
using System.Windows.Threading;
public static class WindowFixture {
  [StructLayout(LayoutKind.Sequential)] public struct Point {public int x,y;}
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd,int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd,int index,int value);
  static Window Make(string title,int x,string initial) {
    var form=new Window {Title=title,Left=x,Top=350,Width=440,Height=600,ShowActivated=false};
    form.Activated+=delegate {Console.Error.WriteLine("Fixture activated: "+title);};
    // WPF ValuePattern may activate an ordinary window. These disposable
    // windows must never interrupt the human's keyboard focus during testing.
    form.SourceInitialized+=delegate {var hwnd=new WindowInteropHelper(form).Handle;SetWindowLong(hwnd,-20,GetWindowLong(hwnd,-20)|0x08000000);};
    var panel=new StackPanel {Margin=new Thickness(25)};
    var input=new TextBox {Text=initial,Margin=new Thickness(0,8,0,20)};
    AutomationProperties.SetName(input,"Note");
    var close=new Button {Content="Close test window"};
    close.Click+=delegate {form.Close();};
        var check=new CheckBox {Content="Handle with care",Margin=new Thickness(0,8,0,0)};
    var checkState=new TextBlock {Text="Care: off"};
    check.Checked+=delegate {checkState.Text="Care: on";};
    check.Unchecked+=delegate {checkState.Text="Care: off";};
    var details=new Expander {Header="Delivery details",Content=new TextBlock {Text="Details are visible"}};
    var selectionState=new TextBlock {Text="Priority: none"};
    var choices=new ListBox {Height=65};
    AutomationProperties.SetName(choices,"Priority");
    choices.Items.Add("Normal");choices.Items.Add("Urgent");
    choices.SelectionChanged+=delegate {selectionState.Text="Priority: "+choices.SelectedItem;};
    var deliveryState=new TextBlock {Text="Delivery: none"};
    var delivery=new ComboBox {Margin=new Thickness(0,5,0,5)};
    AutomationProperties.SetName(delivery,"Delivery method");
    delivery.Items.Add("Standard delivery");delivery.Items.Add("Express delivery");
    delivery.SelectionChanged+=delegate {deliveryState.Text="Delivery: "+delivery.SelectedItem;};
    var scrollState=new TextBlock {Text="Scroll offset: 0"};
    var rows=new ListBox {Height=90};
    AutomationProperties.SetName(rows,"Scroll list");
    VirtualizingStackPanel.SetIsVirtualizing(rows,false);
    for(int i=1;i<=40;i++) rows.Items.Add("Row "+i.ToString("D2"));
    rows.AddHandler(ScrollViewer.ScrollChangedEvent,new ScrollChangedEventHandler(delegate(object sender,ScrollChangedEventArgs args) {
      scrollState.Text="Scroll offset: "+args.VerticalOffset.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }));
    panel.Children.Add(new TextBlock {Text="Note"});panel.Children.Add(input);panel.Children.Add(close);
    panel.Children.Add(check);panel.Children.Add(checkState);panel.Children.Add(details);
    panel.Children.Add(choices);panel.Children.Add(selectionState);panel.Children.Add(delivery);panel.Children.Add(deliveryState);panel.Children.Add(rows);panel.Children.Add(scrollState);
    form.Content=panel;
    return form;
  }
  public static void Run(int parent,string tag) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var before=GetForegroundWindow().ToInt64().ToString();Point cursor;GetCursorPos(out cursor);
    var app=new Application();
    var a=Make(tag+" A",200,"First original");
    var b=Make(tag+" B",720,"Second original");
    a.Show();b.Show();
    Console.WriteLine(new JavaScriptSerializer().Serialize(new {pid=Process.GetCurrentProcess().Id,a=new WindowInteropHelper(a).Handle.ToInt64().ToString(),b=new WindowInteropHelper(b).Handle.ToInt64().ToString(),foreground=before,cursor=cursor}));
    var timer=new DispatcherTimer {Interval=TimeSpan.FromMilliseconds(500)};
    timer.Tick+=delegate {try {if(Process.GetProcessById(parent).HasExited) app.Shutdown();} catch {app.Shutdown();}};
    timer.Start();
    try {app.Run();} finally {timer.Stop();a.Close();b.Close();}
  }
}
'@
[WindowFixture]::Run($ParentId,$Tag)
