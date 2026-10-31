import json
import subprocess
for mode in ('analyze','evaluate'):
    for allocation in range(1,251):
        r=subprocess.run(['build/native/fault_driver',mode,str(allocation)],capture_output=True,text=True,timeout=5)
        assert r.returncode==0,(mode,allocation,r.returncode,r.stderr)
        data=json.loads(r.stdout)
        if data is None or not data['success']:continue
        if mode=='analyze':assert [t['lexeme'] for t in data['tokens']]==['rule','X',':','end',''],(mode,allocation,data)
        else:
            assert len(data['results'])==1,(mode,allocation,data)
            assert len(data['results'][0]['conditions'])==1,(mode,allocation,data)
            assert data['results'][0]['conditions'][0]['outcome']=='TRUE',(mode,allocation,data)
            assert len(data['results'][0]['actions'])==1,(mode,allocation,data)
print('500 allocation-failure API cases passed')
