import assert from 'node:assert/strict'

function node(tree, name, action) {
  const rows=tree.split('\n').filter(line=>/^\t*\d+\s/.test(line) && line.includes(name) && (!action || line.includes(action)))
  assert.equal(rows.length,1,`Expected one ${name} / ${action ?? 'node'} in:\n${tree}`)
  return /^\t*(\d+)\s/.exec(rows[0])[1]
}
function scrollOffset(tree) {
  const match=/text Scroll offset: ([\d.]+)/.exec(tree)
  assert.ok(match,tree)
  return Number(match[1])
}

export async function verifyPatterns(call,read,a,b,text) {
  const act=async(tool,args)=>{
    const result=await call(tool,{app:a,...args})
    assert.equal(result.isError,false,text(result))
    return text(result)
  }
  let tree=await read(a)
  tree=await act('click',{element_index:node(tree,'Handle with care','Toggle')})
  assert.match(tree,/Care: on/)
  assert.match(await read(b),/Care: off/)
  tree=await read(a)
  tree=await act('perform_secondary_action',{element_index:node(tree,'Handle with care','Toggle'),action:'Toggle'})
  assert.match(tree,/Care: off/)

  tree=await act('perform_secondary_action',{element_index:node(tree,'Delivery details','Expand'),action:'Expand'})
  assert.ok(node(tree,'Delivery details','Collapse'))
  tree=await act('perform_secondary_action',{element_index:node(tree,'Delivery details','Collapse'),action:'Collapse'})
  assert.ok(node(tree,'Delivery details','Expand'))

  tree=await act('perform_secondary_action',{element_index:node(tree,'Urgent','Select'),action:'Select'})
  assert.match(tree,/Priority: Urgent/)
  assert.match(await read(b),/Priority: none/)
  tree=await read(a)
  tree=await act('perform_secondary_action',{element_index:node(tree,'Delivery method','Expand'),action:'Expand'})
  assert.ok(node(tree,'Delivery method','Collapse'))
  tree=await act('perform_secondary_action',{element_index:node(tree,'Express delivery','Select'),action:'Select'})
  assert.match(tree,/Delivery: Express delivery/)
  // Some providers leave the popup expanded after programmatic selection.
  const deliveryRow=tree.split('\n').find(line=>line.includes('Delivery method'))
  if(deliveryRow?.includes('Collapse')) {
    tree=await act('perform_secondary_action',{element_index:node(tree,'Delivery method','Collapse'),action:'Collapse'})
  }
  assert.ok(node(tree,'Delivery method','Expand'))
  assert.match(await read(b),/Delivery: none/)
  tree=await read(a)

  assert.equal(scrollOffset(tree),0)
  tree=await act('scroll',{element_index:node(tree,'Scroll list','Scroll'),direction:'down',pages:1})
  assert.ok(scrollOffset(tree)>0,'ScrollPattern must change the actual fixture offset')
  // Action snapshots may use native defaults; use a fresh explicitly sized read
  // before selecting the off-screen item by its own current index.
  tree=await read(a)
  tree=await act('perform_secondary_action',{element_index:node(tree,'Row 40','Select'),action:'ScrollIntoView'})
  assert.ok(scrollOffset(tree)>20,'ScrollItemPattern must bring the last item into view')
  tree=await act('scroll',{element_index:node(tree,'Scroll list','Scroll'),direction:'up',pages:40})
  assert.equal(scrollOffset(tree),0,'scrolling back must reach the actual start')
  assert.equal(scrollOffset(await read(b)),0,'scrolling must not affect the sibling window')
  console.log('PASS: Toggle, Expand, Collapse, SelectionItem, Scroll and ScrollItem; observable state changes and sibling-window isolation')
}
