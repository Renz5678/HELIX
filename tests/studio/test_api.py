"""Contract tests against the real shared C library, never a JS substitute."""
import ctypes
import json
import os
import subprocess
import sys
import unittest

class EngineHarness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = os.environ.get('HELIX_LIBRARY', 'build/native/libhelix.so')
        if not os.path.exists(path):
            raise AssertionError('native analysis API has not been built')
        cls.engine = ctypes.CDLL(os.path.abspath(path))
        cls.engine.helix_analyze.argtypes = [ctypes.c_char_p]
        cls.engine.helix_analyze.restype = ctypes.c_void_p
        cls.engine.helix_free_result.argtypes = [ctypes.c_void_p]


    def analyze(self, source):
        pointer = self.engine.helix_analyze(source.encode())
        self.assertTrue(pointer)
        try:
            return json.loads(ctypes.string_at(pointer))
        finally:
            self.engine.helix_free_result(pointer)


    def evaluate(self, source, rows=None, **extra):
        fn = getattr(self.engine, 'helix_evaluate', None)
        self.assertIsNotNone(fn, 'C evaluation API is missing')
        fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        fn.restype = ctypes.c_void_p
        table = {'name':'glucose_data','patientIdColumn':'patient_id','timestampColumn':'timestamp',
                 'defaultValueColumn':'value','columns':[{'name':'patient_id','type':'String'},
                 {'name':'timestamp','type':'DateTime'},{'name':'value','type':'Float'}],
                 'rows': rows if rows is not None else [
                 {'patient_id':'P001','value':180,'timestamp':'2026-10-31T08:00:00Z'},
                 {'patient_id':'P002','value':275,'timestamp':'2026-10-31T09:00:00Z'},
                 {'patient_id':'P003','value':310,'timestamp':'2026-10-31T10:00:00Z'}]}
        payload={'schemaVersion':1,'evaluationTime':'2026-10-31T12:00:00Z','tables':[table],**extra}
        pointer=fn(source.encode(),json.dumps(payload).encode())
        self.assertTrue(pointer)
        try: return json.loads(ctypes.string_at(pointer))
        finally: self.engine.helix_free_result(pointer)


class AnalysisTests(EngineHarness):
    def test_analysis_tokens_are_authoritative(self):
        data = self.analyze('rule Minimal: end rule')
        self.assertTrue(data['success'])
        self.assertEqual(data['tokenCount'], 5)
        self.assertEqual([t['lexeme'] for t in data['tokens']], ['rule', 'Minimal', ':', 'end', 'rule', ''])
        self.assertEqual(data['diagnostics'], [])


    def test_invalid_utf8_is_rejected_with_valid_json(self):
        pointer=self.engine.helix_analyze(b'rule X: alert "\xff" end rule')
        try:
            data=json.loads(ctypes.string_at(pointer))
            self.assertFalse(data['success'])
        finally:self.engine.helix_free_result(pointer)


    def test_diagnostics_capture_raw_error_span(self):
        data = self.analyze('rule X: @ end rule')
        self.assertFalse(data['success'])
        error = next(d for d in data['diagnostics'] if d['category'] == 'lexical')
        self.assertEqual((error['startOffset'], error['endOffset']), (8, 9))
        self.assertEqual(error['severity'], 'error')


    def test_non_ascii_error_tokens_still_return_valid_json(self):
        d=self.analyze('rule X: é end rule')
        self.assertFalse(d['success'])
        error=next(t for t in d['tokens'] if t['category']=='ERROR')
        self.assertEqual(error['lexeme'],'é')
        self.assertEqual(error['endOffset']-error['startOffset'],2)

    def test_truncated_unicode_diagnostic_is_valid_json(self):
        for prefix in ('','a','ab'):
            d=self.analyze('"'+prefix+('é'*600)+'"')
            self.assertFalse(d['success'])
            self.assertGreater(len(d['diagnostics']),0)

    def test_source_limit_keeps_analysis_schema(self):
        d=self.analyze(' '*1048577)
        self.assertFalse(d['success'])
        self.assertEqual(d['tokenCount'],0)
        self.assertEqual(d['tokens'],[])

    def test_parser_compatibility(self):
        cases = [('', False), ('rule X: end rule', True),
                 ('rule X: when a then end rule', False),
                 ('rule X: when a then alert "x" otherwise end rule', False),
                 ('rule X: suppress end rule', False),
                 ('rule X: suppress within 1 hours end rule', True),
                 ('rule X: let x = f(a)[0]->latest end rule', True),
                 ('rule X: when a then when b then alert "a" otherwise alert "b" end when end when end rule', True)]
        for source, expected in cases:
            with self.subTest(source=source):
                self.assertEqual(self.analyze(source)['success'], expected)


    def test_json_escaping_and_repeated_failures(self):
        for _ in range(100):
            data = self.analyze('rule X: alert "quoted \\" text" end rule')
            self.assertIsInstance(data['diagnostics'], list)


class EvaluationTests(EngineHarness):
    def test_explicit_table_column_latest(self):
        d=self.evaluate('rule X: source glucose_data when glucose_data.value.latest > 250 then alert "yes" end when end rule')
        self.assertTrue(d['success'],d)
        self.assertEqual([r['conditions'][0]['outcome'] for r in d['results']],['FALSE','TRUE','TRUE'])

    def test_grouped_latest_and_alerts(self):
        data=self.evaluate('rule HighGlucoseAlert: source glucose_data when glucose_data.latest > 250 then alert "High glucose", "WARNING" end when end rule')
        self.assertTrue(data['success'],data)
        self.assertEqual([r['conditions'][0]['outcome'] for r in data['results']],['FALSE','TRUE','TRUE'])
        self.assertEqual(sum(len(r['actions']) for r in data['results']),2)


    def test_missing_is_unknown(self):
        data=self.evaluate('rule X: source glucose_data when glucose_data.latest != 250 then alert "bad" otherwise suppress within 1 hours end when end rule',
                           [{'patient_id':'P1','timestamp':'2026-10-31T10:00:00Z','value':None}])
        self.assertTrue(data['success'],data)
        self.assertEqual(data['results'][0]['conditions'][0]['outcome'],'UNKNOWN')
        self.assertEqual(data['results'][0]['actions'],[])


    def test_latest_tie_and_future_exclusion(self):
        rows=[{'patient_id':'P1','timestamp':t,'value':v} for t,v in [
          ('2026-10-31T10:00:00Z',180),('2026-10-31T11:00:00+01:00',275),('2026-11-01T10:00:00Z',1)]]
        data=self.evaluate('rule X: source glucose_data when glucose_data.latest > 250 then alert "yes" end when end rule',rows)
        self.assertTrue(data['success'],data)
        self.assertEqual(data['results'][0]['conditions'][0]['outcome'],'TRUE')
        self.assertEqual(data['results'][0]['conditions'][0]['resolvedValues'][0]['rowIndex'],1)


    def test_runtime_unsupported_is_not_syntax_error(self):
        source='rule X: source glucose_data let x = f(1) when x > 0 then alert "x" end when end rule'
        self.assertTrue(self.analyze(source)['success'])
        data=self.evaluate(source)
        self.assertFalse(data['success'])
        self.assertTrue(data['analysisSuccess'])
        self.assertTrue(any(d['category']=='semantic' for d in data['diagnostics']))


    def test_filter_literals_are_cached_within_bounded_memory(self):
        code = """import sys,resource
sys.path.insert(0,'tests/studio')
from test_api import EvaluationTests
EvaluationTests.setUpClass()
limit=int(open('/proc/self/statm').read().split()[0])*resource.getpagesize()+128*1024*1024
resource.setrlimit(resource.RLIMIT_AS,(limit,limit))
source='rule X: bind x = glucose_data where patient_id == "'+('x'*200000)+'" end bind when x.latest > 0 then alert "x" end when end rule'
rows=[{'patient_id':'P1','value':1,'timestamp':'2026-10-31T11:00:00Z'}]*2500
print(EvaluationTests().evaluate(source,rows)['success'])
"""
        r=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=20)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(r.stdout.strip(),'True')


    def test_invalid_suppress_operand_reports_error(self):
        data=self.evaluate('rule X: source glucose_data let reason = 5 when glucose_data.latest > 0 then suppress reason end when end rule')
        self.assertFalse(data['success'],data)


    def test_outer_otherwise_after_nested_otherwise(self):
        d=self.evaluate('rule X: source glucose_data when glucose_data.latest > 250 then when glucose_data.latest > 0 then alert "inner" otherwise alert "inner-false" end when otherwise alert "outer" end when end rule')
        self.assertTrue(d['success'],d)
        self.assertEqual(d['results'][0]['actions'][0]['message'],'outer')


    def test_filter_columns_are_scoped_to_bound_table(self):
        other={'name':'Other','columns':[{'name':'patient_id','type':'String'},{'name':'timestamp','type':'DateTime'},{'name':'value','type':'Float'},{'name':'status','type':'String'}],'rows':[]}
        t={'name':'T','columns':[{'name':'patient_id','type':'String'},{'name':'timestamp','type':'DateTime'},{'name':'value','type':'Float'}],'rows':[]}
        d=self.evaluate('rule X: bind x = T.value where status == "final" end bind when x.latest > 0 then alert "bad" end when end rule',tables=[t,other])
        self.assertFalse(d['success'],d)
        self.assertEqual(d['results'],[])


    def test_nonfinite_literal_is_rejected(self):
        data=self.evaluate('rule X: source glucose_data when glucose_data.latest < '+('9'*310)+' then alert "bad" end when end rule')
        self.assertFalse(data['success'],data)


    def test_branch_local_declarations_are_independent(self):
        data=self.evaluate('rule X: source glucose_data when glucose_data.latest > 250 then let x = 1 alert "yes" otherwise let x = 2 suppress within 1 hours end when end rule')
        self.assertTrue(data['success'],data)


    def test_let_duration_variable(self):
        data=self.evaluate('rule X: source glucose_data let window = "2h" bind x = glucose_data within window end bind when x.latest > 250 then alert "yes" end when end rule')
        self.assertTrue(data['success'],data)


    def test_filter_and_window_before_latest(self):
        table={'name':'readings','patientIdColumn':'patient_id','timestampColumn':'timestamp','defaultValueColumn':'value',
        'columns':[{'name':'patient_id','type':'String'},{'name':'timestamp','type':'DateTime'},{'name':'value','type':'Float'},{'name':'status','type':'String'}],
        'rows':[{'patient_id':'P1','value':275,'status':'final','timestamp':'2026-10-31T11:45:00Z'},
                {'patient_id':'P1','value':100,'status':'preliminary','timestamp':'2026-10-31T11:59:00Z'}]}
        data=self.evaluate('rule X: bind hr = readings.value where status == "final" within 30 minutes end bind when hr.latest > 250 within 15 minutes then alert "yes" end when end rule',tables=[table])
        self.assertTrue(data['success'],data)
        self.assertEqual(data['results'][0]['conditions'][0]['outcome'],'TRUE')
        self.assertEqual(data['results'][0]['conditions'][0]['resolvedValues'][0]['rowIndex'],0)


    def test_all_three_valued_truth_pairs(self):
        expected_and=[['FALSE','FALSE','FALSE'],['FALSE','TRUE','UNKNOWN'],['FALSE','UNKNOWN','UNKNOWN']]
        expected_or=[['FALSE','TRUE','UNKNOWN'],['TRUE','TRUE','TRUE'],['UNKNOWN','TRUE','UNKNOWN']]
        values=[False,True,None]
        for op,expected in [('and',expected_and),('or',expected_or)]:
            for a,av in enumerate(values):
                for b,bv in enumerate(values):
                    t={'name':'T','patientIdColumn':'patient_id','timestampColumn':'timestamp','defaultValueColumn':'a',
                    'columns':[{'name':'patient_id','type':'String'},{'name':'timestamp','type':'DateTime'},{'name':'a','type':'Boolean'},{'name':'b','type':'Boolean'}],
                    'rows':[{'patient_id':'P1','timestamp':'2026-10-31T11:00:00Z','a':av,'b':bv}]}
                    d=self.evaluate(f'rule X: bind a = T.a end bind bind b = T.b end bind when a.latest {op} b.latest then alert "yes" end when end rule',tables=[t])
                    self.assertTrue(d['success'],d)
                    self.assertEqual(d['results'][0]['conditions'][0]['outcome'],expected[a][b],(op,av,bv,d))


    def test_recursive_series_filter_is_rejected_without_crash(self):
        source='rule X: bind x = glucose_data where x.latest > 0 end bind when x.latest > 0 then alert "a" end when end rule'
        code="import sys;sys.path.insert(0,'tests/studio');from test_api import EvaluationTests;EvaluationTests.setUpClass();print(EvaluationTests().evaluate("+repr(source)+")['success'])"
        result=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout.strip(),'False')


    def test_data_diagnostics_include_cell_context(self):
        d=self.evaluate('rule X: source glucose_data when glucose_data.latest > 0 then alert "x" end when end rule',[{'patient_id':'P1','timestamp':'2026-10-31T10:00:00Z','value':'bad'}])
        self.assertFalse(d['success'])
        error=d['diagnostics'][0]
        self.assertEqual((error['tableName'],error['rowIndex'],error['columnName']),('glucose_data',0,'value'))


    def test_evaluation_syntax_diagnostics_keep_source_spans(self):
        d=self.evaluate('rule X: source glucose_data when > then alert "bad" end when end rule')
        self.assertFalse(d['success'])
        self.assertTrue(all('startOffset' in x for x in d['diagnostics']))


    def test_complexity_limits_fail_cleanly(self):
        d=self.evaluate('rule X: source glucose_data when '+('not '*300)+'glucose_data.latest > 0 then alert "x" end when end rule')
        self.assertFalse(d['success'])
        table={'name':'T','columns':[{'name':'patient_id','type':'String'},{'name':'timestamp','type':'DateTime'},{'name':'value','type':'Float'}],'rows':[{'patient_id':'P1','timestamp':'2026-10-31T11:00:00Z','value':1}]*10001}
        d=self.evaluate('rule X: source T when T.latest > 0 then alert "x" end when end rule',tables=[table])
        self.assertFalse(d['success'])
        self.assertEqual(d['results'],[])

    def test_multi_source_union_never_crosses_patients(self):
        def table(name,patient):return {'name':name,'columns':[{'name':'patient_id','type':'String'},{'name':'timestamp','type':'DateTime'},{'name':'value','type':'Float'}],'rows':[{'patient_id':patient,'timestamp':'2026-10-31T11:00:00Z','value':1}]}
        d=self.evaluate('rule X: bind a = T.value end bind bind b = U.value end bind when a.latest > 0 and b.latest > 0 then alert "bad" end when end rule',tables=[table('T','P1'),table('U','P2')])
        self.assertTrue(d['success'],d)
        self.assertEqual([r['patientId'] for r in d['results']],['P1','P2'])
        self.assertEqual([r['conditions'][0]['outcome'] for r in d['results']],['UNKNOWN','UNKNOWN'])
        self.assertTrue(all(not r['actions'] for r in d['results']))

    def test_invalid_dates_and_duplicate_json_keys(self):
        data=self.evaluate('rule X: source glucose_data when glucose_data.latest > 0 then alert "x" end when end rule',evaluationTime='2026-02-30T12:00:00Z')
        self.assertFalse(data['success'])


if __name__ == '__main__':
    unittest.main()
