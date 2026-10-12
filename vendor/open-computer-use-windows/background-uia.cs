// Freebuff addition. ABI slots and interface IDs: Windows SDK UIAutomationClient.h.
// Microsoft documents AutoSetFocus=false for background Invoke/SetValue actions.
// Use the same configured COM client for lookup AND patterns; managed static
// AutomationElement calls use a different client with automatic focus enabled.
using System;
using System.Runtime.InteropServices;

public static class BackgroundAutomation {
    [DllImport("ole32.dll", ExactSpelling=true)]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IntPtr instance);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PutBool(IntPtr self, int value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetBool(IntPtr self, out int value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FromHandle(IntPtr self, IntPtr hwnd, out IntPtr element);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PropertyCondition(IntPtr self, int property, [MarshalAs(UnmanagedType.Struct)] object value, out IntPtr condition);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FindFirst(IntPtr self, int scope, IntPtr condition, out IntPtr element);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PatternAs(IntPtr self, int pattern, ref Guid iid, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int NoArgs(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetText(IntPtr self, [MarshalAs(UnmanagedType.LPWStr)] string text);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ScrollArgs(IntPtr self, int horizontal, int vertical);
    static T Method<T>(IntPtr instance, int slot) where T:class {
        if(instance==IntPtr.Zero) throw new InvalidOperationException("Accessibility object is unavailable.");
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance),slot*IntPtr.Size),typeof(T)) as T;
    }
    static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
    static void Release(IntPtr value) { if(value!=IntPtr.Zero) Marshal.Release(value); }

    public static void Run(IntPtr window, int[] runtimeId, string action, string value, int horizontal, int vertical) {
        int patternId, slot=3; string patternIid;
        switch(action) {
            case "invoke": patternId=10000;patternIid="fb377fbe-8ea6-46d5-9c73-6499642d3059";break;
            case "setvalue": patternId=10002;patternIid="a94cd8b1-0844-4cd6-9d2d-640537ab39e9";break;
            case "scroll": patternId=10004;patternIid="88f4d42a-e881-459d-a77c-73bbbb7e02dc";break;
            case "expand": case "collapse": patternId=10005;patternIid="619be086-1f4e-4ee4-bafa-210128738730";slot=action=="collapse"?4:3;break;
            case "select": patternId=10010;patternIid="a8efa66a-0fda-421a-9194-38021f3578ea";break;
            case "toggle": patternId=10015;patternIid="94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70";break;
            case "scrollintoview": patternId=10017;patternIid="b488300f-d015-4f19-9c29-bb595e3645ef";break;
            default: throw new ArgumentException("Unsupported background accessibility action.");
        }
        if(window==IntPtr.Zero || runtimeId==null || runtimeId.Length==0) throw new ArgumentException("A window and element runtime identity are required.");
        IntPtr client=IntPtr.Zero,root=IntPtr.Zero,condition=IntPtr.Zero,element=IntPtr.Zero,pattern=IntPtr.Zero;
        try {
            var clsid=new Guid("e22ad333-b25f-460c-83d0-0581107395c9");
            var iid=new Guid("34723aff-0c9d-49d0-9896-7ab52df8cd8a");
            Check(CoCreateInstance(ref clsid,IntPtr.Zero,1,ref iid,out client));
            Check(Method<PutBool>(client,59)(client,0));
            int autoFocus;Check(Method<GetBool>(client,58)(client,out autoFocus));
            if(autoFocus!=0) throw new InvalidOperationException("Could not disable UI Automation automatic focus; no action sent.");
            Check(Method<FromHandle>(client,6)(client,window,out root));
            // RuntimeIdProperty=30000; TreeScope_Subtree=7. Search only the
            // validated selected window, never the desktop or all process windows.
            Check(Method<PropertyCondition>(client,23)(client,30000,runtimeId,out condition));
            Check(Method<FindFirst>(root,5)(root,7,condition,out element));
            if(element==IntPtr.Zero) throw new InvalidOperationException("Selected element is gone; refresh this window before acting.");
            iid=new Guid(patternIid);
            Check(Method<PatternAs>(element,14)(element,patternId,ref iid,out pattern));
            if(action=="setvalue") Check(Method<SetText>(pattern,slot)(pattern,value));
            else if(action=="scroll") Check(Method<ScrollArgs>(pattern,slot)(pattern,horizontal,vertical));
            else Check(Method<NoArgs>(pattern,slot)(pattern));
        } finally {Release(pattern);Release(element);Release(condition);Release(root);Release(client);}
    }
}
